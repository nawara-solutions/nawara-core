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
  /**
   * ISO 4217 codes this deployment accepts on an invoice or price (BI-11). NO code default: which currencies are supported is B-005, so
   * an operator must say. A code must also exist in the immutable `currency` table (BI-21), which is seeded by migration.
   */
  supportedCurrencies: string[];
  /** OpenAPI is mounted at /billing/docs behind basic auth, and only when a password is configured. */
  docs: { username: string; password?: string };
  /** Baseline abuse limits (SDD section 29): requests per minute per AUTHENTICATED caller. Technical values, no business meaning. */
  rateLimits: { invoiceCreatePerMinute: number; paymentRequestCreatePerMinute: number };
  /** Stage 4: the one outbound dependency Billing has. Billing's OWN service token for the pair billing -> payment (ADR-0033, SDD section 20) — never a user's JWT, never forwarded from anywhere else. */
  paymentServiceUrl: string;
  paymentServiceToken: string;
  paymentTimeoutMs: number;
  /**
   * Dispatcher polling (SDD section 21.5): technical tuning, no business meaning. `staleSendingMs` is also the
   * dispatcher's own retry threshold — a `sending` row older than this is re-claimed and re-sent (safe: the natural
   * key makes a repeated create idempotent), so a stuck dispatch never needs the reconciler at all.
   */
  dispatch: { intervalMs: number; batchSize: number; staleSendingMs: number };
  /** Reconciler polling and staleness threshold for `requested` rows with no terminal event yet (SDD section 21.5): technical tuning, no business meaning. */
  reconcile: { intervalMs: number; staleRequestedMs: number };
  /**
   * Retry policy of the Payment event consumer's RabbitMQ bus (audit M-07): how many times a possibly-transient processing failure is retried
   * (0 = dead-letter on the first failure) and how long each retry waits in `billing.payment-events.retry`. Technical tuning, no business meaning.
   */
  paymentEventRetry: { maxRetries: number; delayMs: number };
  /**
   * Stage 12.2 R1: the ONE trusted authority for a Subscription's grace-period length. `undefined` means this
   * deployment offers no grace at all (subscriptions go straight from `active` to `expired`). A business value with NO
   * Nawara-wide default — an operator must say, exactly like `supportedCurrencies` — so no caller of the Subscription
   * domain can grant an arbitrary commercial extension by supplying its own `graceUntil`; only this configured
   * duration, applied by `SubscriptionRepository` itself at activate/renew time, ever produces one.
   */
  subscriptionGraceDays?: number;
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

  const supportedCurrencies = reader
    .required('BILLING_SUPPORTED_CURRENCIES')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (supportedCurrencies.length === 0 || supportedCurrencies.some((c) => !/^[A-Z]{3}$/.test(c))) {
    throw new ConfigError('BILLING_SUPPORTED_CURRENCIES must list three-letter ISO 4217 codes, comma-separated');
  }

  // No default: an unset SUBSCRIPTION_GRACE_DAYS means this deployment offers no grace at all, never "pick a number for it".
  const graceDaysRaw = reader.optional('SUBSCRIPTION_GRACE_DAYS');
  let subscriptionGraceDays: number | undefined;
  if (graceDaysRaw !== undefined) {
    const n = Number(graceDaysRaw);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new ConfigError('SUBSCRIPTION_GRACE_DAYS must be an integer between 1 and 365');
    subscriptionGraceDays = n;
  }

  return {
    ...base,
    databaseUrl,
    supportedCurrencies: [...new Set(supportedCurrencies)],
    subscriptionGraceDays,
    serviceTokens: parseServiceTokens(reader.get('SERVICE_TOKENS')),
    authServiceUrl: reader.url('AUTH_SERVICE_URL', ['http:', 'https:']),
    authTimeoutMs: reader.int('AUTH_TIMEOUT_MS', { default: 3000, min: 100, max: 30_000 }),
    rabbitmqUrl,
    docs: {
      username: reader.optional('SWAGGER_USERNAME', 'docs') as string,
      // A password that protects financial API documentation must not be trivial.
      password: reader.get('SWAGGER_PASSWORD') === undefined ? undefined : reader.secret('SWAGGER_PASSWORD', 16),
    },
    rateLimits: {
      invoiceCreatePerMinute: reader.int('BILLING_RATE_LIMIT_INVOICE_CREATE_PER_MINUTE', { default: 300, min: 1, max: 100_000 }),
      paymentRequestCreatePerMinute: reader.int('BILLING_RATE_LIMIT_PAYMENT_REQUEST_CREATE_PER_MINUTE', { default: 30, min: 1, max: 100_000 }),
    },
    paymentServiceUrl: reader.url('PAYMENT_SERVICE_URL', ['http:', 'https:']),
    paymentServiceToken: reader.secret('PAYMENT_SERVICE_TOKEN', 32),
    paymentTimeoutMs: reader.int('PAYMENT_TIMEOUT_MS', { default: 5000, min: 100, max: 60_000 }),
    dispatch: {
      intervalMs: reader.int('BILLING_DISPATCH_INTERVAL_MS', { default: 2000, min: 100, max: 300_000 }),
      batchSize: reader.int('BILLING_DISPATCH_BATCH_SIZE', { default: 50, min: 1, max: 1000 }),
      staleSendingMs: reader.int('BILLING_DISPATCH_STALE_SENDING_MS', { default: 60_000, min: 1000, max: 3_600_000 }),
    },
    reconcile: {
      intervalMs: reader.int('BILLING_RECONCILE_INTERVAL_MS', { default: 30_000, min: 1000, max: 3_600_000 }),
      staleRequestedMs: reader.int('BILLING_RECONCILE_STALE_REQUESTED_MS', { default: 300_000, min: 1000, max: 86_400_000 }),
    },
    paymentEventRetry: {
      maxRetries: reader.int('BILLING_PAYMENT_EVENT_RETRY_MAX', { default: 3, min: 0, max: 10 }),
      delayMs: reader.int('BILLING_PAYMENT_EVENT_RETRY_DELAY_MS', { default: 5000, min: 100, max: 300_000 }),
    },
  };
}

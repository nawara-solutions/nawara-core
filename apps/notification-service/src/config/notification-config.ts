import {
  ConfigError, DEFAULT_RABBITMQ_HEARTBEAT_S, EnvReader, RABBITMQ_HEARTBEAT_BOUNDS, loadBaseConfig, parseServiceTokens, type BaseConfig,
  type ServiceTokenEntry,
} from '@nawara/service-kit';
import { NotificationCallerPolicy } from '../api/caller-policy.js';

/** The one identity of this service: logs, the database `application_name`, Docker, documentation. */
export const SERVICE_NAME = 'notification-service';

/** BCP 47 locale shape, as the template versions store it (SDD §6.4). */
export const LOCALE_SHAPE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * notification-service configuration, layered on the kit's shared `BaseConfig`. It carries ONLY what the service uses today:
 * - the HTTP baseline (Stage 16.3) and the accepted service callers;
 * - the database (Stage 16.4: `DATABASE_URL` plus the kit's bounded `DB_*` limits in `BaseConfig.db`);
 * - Stage 16.5, event intake: the broker, the secret key ring and the platform default locale;
 * - Stage 16.6, the send API: the caller policy, the request-hash key, the schedule bound, the per-caller intake limit, the API docs;
 * - Stage 16.7, the delivery engine: the provider choice (the test provider only, never in production), the worker's pace, lease,
 *   timeout, retry, time zone and the caller+template limit, with the SDD §8.2 relationships enforced at startup.
 *
 * Deliberately absent until the stage that uses it: real provider settings and credentials (16.8).
 */
export interface NotificationConfig extends BaseConfig {
  /** Runtime connection: the least-privilege `notification_app` role (ADR-0032), never the schema owner or a superuser. */
  databaseUrl: string;
  /**
   * Accepted callers, `<caller>:<sha256 digest>` (ADR-0033). Empty (the default) means every service-token call is refused: fail
   * closed. No route uses it yet; the send API (16.6) will.
   */
  serviceTokens: ServiceTokenEntry[];
  /** `RABBITMQ_URL` (required): the broker the event intake consumes from (queue `notification.events`, SDD §7.1). */
  rabbitmqUrl: string;
  /** `RABBITMQ_CONFIRM_TIMEOUT_MS` (default 5000, 100-60000): bound on the confirm of the kit's retry / dead-letter copies. */
  rabbitmqConfirmTimeoutMs: number;
  /** `RABBITMQ_HEARTBEAT_S` (Stage 15.3; default 10, 5-60): a silent broker is detected within about 3 x this. */
  rabbitmqHeartbeatS: number;
  /**
   * `NOTIFICATION_SECRET_KEYS` (`id:base64(32 bytes)[,…]`) and `NOTIFICATION_SECRET_ACTIVE_KEY_ID` (SDD §12.1, Auth's TOTP ring
   * pattern): AES-256-GCM keys that seal a notification's secret variables (one-time codes). Required, no default, never logged.
   */
  secretKeys: Map<string, Buffer>;
  secretActiveKeyId: string;
  /**
   * `NOTIFICATION_DEFAULT_LOCALE` (required, BCP 47): the last step of locale resolution (SDD §6.4). The copy and this value are
   * product inputs (D7). The event intake refuses to start while a mapped template lacks a published version in it.
   */
  defaultLocale: string;
  /** `NOTIFICATION_SERVICE_POLICY` (SDD §11.2): what each authenticated caller may request. Deny by default. */
  callerPolicy: NotificationCallerPolicy;
  /**
   * `NOTIFICATION_REQUEST_HASH_KEY` (required; base64 of at least 32 random bytes; Stage 16.6 decision): the HMAC-SHA-256 key of the API
   * request hash. An unkeyed hash would let anyone reading the database brute-force a one-time code from it. Never stored, never logged.
   */
  requestHashKey: Buffer;
  /** `NOTIFICATION_MAX_SCHEDULE_AHEAD_SEC` (SDD §9.1; default 2592000 = 30 days, 60-31536000): how far ahead `scheduledAt` may be. */
  maxScheduleAheadSec: number;
  /** `NOTIFICATION_API_INTAKE_LIMIT_PER_MINUTE` (SDD §11.3 `notif_api_caller`; default 600, 1-100000): accepted API calls per caller per minute. */
  apiIntakeLimitPerMinute: number;
  /** OpenAPI at `/notification/docs`, behind basic auth, mounted only when `SWAGGER_PASSWORD` (16+ characters) is set. */
  docs: { username: string; password?: string };
  /** Stage 16.7: the delivery engine. `provider: 'none'` (the default) runs no worker: deliveries stay PENDING. */
  delivery: DeliveryConfig;
}

export interface DeliveryConfig {
  /** `NOTIFICATION_DELIVERY_PROVIDER`: `none` (no worker) or `test` (the no-network test provider; refused in production). */
  provider: 'none' | 'test';
  /** `NOTIFICATION_WORKER_INTERVAL_MS` (1000, 100-60000): the pause between two passes. */
  intervalMs: number;
  /** `NOTIFICATION_WORKER_BATCH_SIZE` (20, 1-500): deliveries claimed per pass. */
  batchSize: number;
  /** `NOTIFICATION_WORKER_CONCURRENCY` (4, 1-50, < DB_POOL_MAX): provider calls in flight at once, per instance. */
  concurrency: number;
  /** `NOTIFICATION_LEASE_MS` (60000, 5000-3600000, >= 2 x the provider timeout): how long a claim is held without renewal. */
  leaseMs: number;
  /** `NOTIFICATION_PROVIDER_TIMEOUT_MS` (10000, 100-30000): the bound on one provider call; past it the call is ambiguous. */
  providerTimeoutMs: number;
  /** `NOTIFICATION_RETRY_BASE_MS` (30000, 1000-3600000) and `NOTIFICATION_RETRY_CEILING_MS` (1800000, >= base, <= 86400000). */
  retryBaseMs: number;
  retryCeilingMs: number;
  /** `NOTIFICATION_MAX_ATTEMPTS` (5, 1-20): provider calls per delivery before `FAILED retries_exhausted`. */
  maxAttempts: number;
  /** `NOTIFICATION_TIME_ZONE` (`UTC`; an IANA zone): the platform time zone datetimes are rendered in (D22). */
  timeZone: string;
  /** `NOTIFICATION_RATE_CALLER_TEMPLATE_PER_MINUTE` (6000, 1-1000000): sends per source + template per minute (SDD §11.3). */
  callerTemplateLimitPerMinute: number;
  /** The worker's drain at shutdown: the provider timeout plus 2 s, so an in-flight send can finish (SDD §8.2). */
  drainTimeoutMs: number;
}

/** Stage 15.5: the container stop grace every Core service is given; SDD §8.2 bounds the provider timeout by it. */
export const STOP_GRACE_MS = 60_000;

function deliveryConfig(reader: EnvReader, base: BaseConfig): DeliveryConfig {
  const provider = reader.oneOf('NOTIFICATION_DELIVERY_PROVIDER', ['none', 'test'] as const, 'none');
  if (provider === 'test' && base.isProduction) throw new ConfigError('NOTIFICATION_DELIVERY_PROVIDER=test is refused in production (it delivers nothing)');
  const leaseMs = reader.int('NOTIFICATION_LEASE_MS', { default: 60_000, min: 5_000, max: 3_600_000 });
  const providerTimeoutMs = reader.int('NOTIFICATION_PROVIDER_TIMEOUT_MS', { default: 10_000, min: 100, max: 30_000 });
  if (leaseMs < 2 * providerTimeoutMs) throw new ConfigError('NOTIFICATION_LEASE_MS must be at least 2 x NOTIFICATION_PROVIDER_TIMEOUT_MS');
  if (providerTimeoutMs >= STOP_GRACE_MS - base.httpDrainTimeoutMs) throw new ConfigError('NOTIFICATION_PROVIDER_TIMEOUT_MS must be shorter than the 60 s stop grace minus HTTP_DRAIN_TIMEOUT_MS');
  const retryBaseMs = reader.int('NOTIFICATION_RETRY_BASE_MS', { default: 30_000, min: 1_000, max: 3_600_000 });
  const retryCeilingMs = reader.int('NOTIFICATION_RETRY_CEILING_MS', { default: 1_800_000, min: 1_000, max: 86_400_000 });
  if (retryCeilingMs < retryBaseMs) throw new ConfigError('NOTIFICATION_RETRY_CEILING_MS must be at least NOTIFICATION_RETRY_BASE_MS');
  const concurrency = reader.int('NOTIFICATION_WORKER_CONCURRENCY', { default: 4, min: 1, max: 50 });
  if (concurrency >= base.db.poolMax) throw new ConfigError('NOTIFICATION_WORKER_CONCURRENCY must be smaller than DB_POOL_MAX');
  const timeZone = reader.optional('NOTIFICATION_TIME_ZONE', 'UTC') as string;
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
  } catch {
    throw new ConfigError('NOTIFICATION_TIME_ZONE must be an IANA time zone such as UTC or Africa/Tunis');
  }
  return {
    provider, leaseMs, providerTimeoutMs, retryBaseMs, retryCeilingMs, concurrency, timeZone,
    intervalMs: reader.int('NOTIFICATION_WORKER_INTERVAL_MS', { default: 1_000, min: 100, max: 60_000 }),
    batchSize: reader.int('NOTIFICATION_WORKER_BATCH_SIZE', { default: 20, min: 1, max: 500 }),
    maxAttempts: reader.int('NOTIFICATION_MAX_ATTEMPTS', { default: 5, min: 1, max: 20 }),
    callerTemplateLimitPerMinute: reader.int('NOTIFICATION_RATE_CALLER_TEMPLATE_PER_MINUTE', { default: 6_000, min: 1, max: 1_000_000 }),
    drainTimeoutMs: providerTimeoutMs + 2_000,
  };
}

/** Database users that must never run the service in production: the default superuser name and any schema-owner role. */
const FORBIDDEN_RUNTIME_DB_USER = /^(postgres|root|.+_migrator)$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

function secretKeyRing(reader: EnvReader): { keys: Map<string, Buffer>; activeKeyId: string } {
  const keys = new Map<string, Buffer>();
  for (const pair of reader.required('NOTIFICATION_SECRET_KEYS').split(',')) {
    const i = pair.indexOf(':');
    const id = pair.slice(0, Math.max(i, 0)).trim();
    const key = Buffer.from(pair.slice(i + 1).trim(), 'base64');
    if (i < 1 || !KEY_ID.test(id) || key.length !== 32 || keys.has(id)) {
      throw new ConfigError('NOTIFICATION_SECRET_KEYS must be "id:base64(32 bytes)[,id:base64(32 bytes)]" with distinct ids');
    }
    keys.set(id, key);
  }
  if (new Set([...keys.values()].map((k) => k.toString('hex'))).size !== keys.size) {
    throw new ConfigError('NOTIFICATION_SECRET_KEYS must not repeat a key');
  }
  const activeKeyId = reader.required('NOTIFICATION_SECRET_ACTIVE_KEY_ID');
  if (!keys.has(activeKeyId)) throw new ConfigError('NOTIFICATION_SECRET_ACTIVE_KEY_ID does not name a key in NOTIFICATION_SECRET_KEYS');
  return { keys, activeKeyId };
}

/** Throws `ConfigError` (never echoing a value) on any missing or invalid setting, before anything starts. */
export function loadNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig(SERVICE_NAME, env, reader);
  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  if (base.isProduction && FORBIDDEN_RUNTIME_DB_USER.test(decodeURIComponent(new URL(databaseUrl).username))) {
    // ADR-0032: the runtime role is DML-only. Refuse a superuser or schema-owner login rather than run with DDL rights.
    throw new ConfigError('DATABASE_URL must use the least-privilege runtime role in production, not a superuser or migrator role');
  }
  const ring = secretKeyRing(reader);
  const requestHashKey = Buffer.from(reader.required('NOTIFICATION_REQUEST_HASH_KEY'), 'base64');
  if (requestHashKey.length < 32) throw new ConfigError('NOTIFICATION_REQUEST_HASH_KEY must be the base64 of at least 32 random bytes');
  if ([...ring.keys.values()].some((k) => k.equals(requestHashKey))) {
    throw new ConfigError('NOTIFICATION_REQUEST_HASH_KEY must differ from every NOTIFICATION_SECRET_KEYS key (one key, one purpose)');
  }
  const serviceTokens = parseServiceTokens(reader.get('SERVICE_TOKENS'));
  const defaultLocale = reader.required('NOTIFICATION_DEFAULT_LOCALE');
  if (!LOCALE_SHAPE.test(defaultLocale) || defaultLocale.length > 35) throw new ConfigError('NOTIFICATION_DEFAULT_LOCALE must be a BCP 47 locale such as en or fr');
  return {
    ...base,
    databaseUrl,
    serviceTokens,
    rabbitmqUrl: reader.url('RABBITMQ_URL', ['amqp:', 'amqps:']),
    rabbitmqConfirmTimeoutMs: reader.int('RABBITMQ_CONFIRM_TIMEOUT_MS', { default: 5_000, min: 100, max: 60_000 }),
    rabbitmqHeartbeatS: reader.int('RABBITMQ_HEARTBEAT_S', { default: DEFAULT_RABBITMQ_HEARTBEAT_S, ...RABBITMQ_HEARTBEAT_BOUNDS }),
    secretKeys: ring.keys,
    secretActiveKeyId: ring.activeKeyId,
    defaultLocale,
    callerPolicy: NotificationCallerPolicy.parse(reader.get('NOTIFICATION_SERVICE_POLICY'), [...new Set(serviceTokens.map((t) => t.caller))]),
    requestHashKey,
    maxScheduleAheadSec: reader.int('NOTIFICATION_MAX_SCHEDULE_AHEAD_SEC', { default: 2_592_000, min: 60, max: 31_536_000 }),
    apiIntakeLimitPerMinute: reader.int('NOTIFICATION_API_INTAKE_LIMIT_PER_MINUTE', { default: 600, min: 1, max: 100_000 }),
    docs: {
      username: reader.optional('SWAGGER_USERNAME', 'docs') as string,
      password: reader.get('SWAGGER_PASSWORD') === undefined ? undefined : reader.secret('SWAGGER_PASSWORD', 16),
    },
    delivery: deliveryConfig(reader, base),
  };
}

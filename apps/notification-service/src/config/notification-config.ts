import {
  ConfigError, DEFAULT_RABBITMQ_HEARTBEAT_S, EnvReader, RABBITMQ_HEARTBEAT_BOUNDS, loadBaseConfig, parseServiceTokens, type BaseConfig,
  type ServiceTokenEntry,
} from '@nawara/service-kit';

/** The one identity of this service: logs, the database `application_name`, Docker, documentation. */
export const SERVICE_NAME = 'notification-service';

/** BCP 47 locale shape, as the template versions store it (SDD §6.4). */
export const LOCALE_SHAPE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * notification-service configuration, layered on the kit's shared `BaseConfig`. It carries ONLY what the service uses today:
 * - the HTTP baseline (Stage 16.3) and the accepted service callers;
 * - the database (Stage 16.4: `DATABASE_URL` plus the kit's bounded `DB_*` limits in `BaseConfig.db`);
 * - Stage 16.5, event intake: the broker, the secret key ring and the platform default locale.
 *
 * Deliberately absent until the stage that uses it: `NOTIFICATION_SERVICE_POLICY` and API docs (16.6, the send API), worker and
 * provider settings (16.7 / 16.8).
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
  const defaultLocale = reader.required('NOTIFICATION_DEFAULT_LOCALE');
  if (!LOCALE_SHAPE.test(defaultLocale) || defaultLocale.length > 35) throw new ConfigError('NOTIFICATION_DEFAULT_LOCALE must be a BCP 47 locale such as en or fr');
  return {
    ...base,
    databaseUrl,
    serviceTokens: parseServiceTokens(reader.get('SERVICE_TOKENS')),
    rabbitmqUrl: reader.url('RABBITMQ_URL', ['amqp:', 'amqps:']),
    rabbitmqConfirmTimeoutMs: reader.int('RABBITMQ_CONFIRM_TIMEOUT_MS', { default: 5_000, min: 100, max: 60_000 }),
    rabbitmqHeartbeatS: reader.int('RABBITMQ_HEARTBEAT_S', { default: DEFAULT_RABBITMQ_HEARTBEAT_S, ...RABBITMQ_HEARTBEAT_BOUNDS }),
    secretKeys: ring.keys,
    secretActiveKeyId: ring.activeKeyId,
    defaultLocale,
  };
}

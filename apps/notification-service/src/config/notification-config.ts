import { ConfigError, EnvReader, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry } from '@nawara/service-kit';

/** The one identity of this service: logs, the kit's database `application_name` and event `source` later, Docker, documentation. */
export const SERVICE_NAME = 'notification-service';

/**
 * notification-service configuration, layered on the kit's shared `BaseConfig`. It carries ONLY what the service uses today: the HTTP
 * baseline (Stage 16.3), the accepted service callers, and the database (Stage 16.4: `DATABASE_URL` plus the kit's bounded `DB_*`
 * pool and timeout limits in `BaseConfig.db`).
 *
 * Deliberately absent until the stage that uses it (ADR-0046, Stage 16.1 roadmap): `RABBITMQ_*` (16.5, event intake),
 * `NOTIFICATION_SECRET_KEYS` and `NOTIFICATION_DEFAULT_LOCALE` (16.5, sealing and locale resolution at intake),
 * `NOTIFICATION_SERVICE_POLICY` and API docs (16.6, the send API), worker and provider settings (16.7 / 16.8).
 */
export interface NotificationConfig extends BaseConfig {
  /** Runtime connection: the least-privilege `notification_app` role (ADR-0032), never the schema owner or a superuser. */
  databaseUrl: string;
  /**
   * Accepted callers, `<caller>:<sha256 digest>` (ADR-0033). Empty (the default) means every service-token call is refused: fail
   * closed. No route uses it yet; the send API (16.6) will.
   */
  serviceTokens: ServiceTokenEntry[];
}

/** Database users that must never run the service in production: the default superuser name and any schema-owner role. */
const FORBIDDEN_RUNTIME_DB_USER = /^(postgres|root|.+_migrator)$/;

/** Throws `ConfigError` (never echoing a value) on any missing or invalid setting, before anything starts. */
export function loadNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig(SERVICE_NAME, env, reader);
  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  if (base.isProduction && FORBIDDEN_RUNTIME_DB_USER.test(decodeURIComponent(new URL(databaseUrl).username))) {
    // ADR-0032: the runtime role is DML-only. Refuse a superuser or schema-owner login rather than run with DDL rights.
    throw new ConfigError('DATABASE_URL must use the least-privilege runtime role in production, not a superuser or migrator role');
  }
  return {
    ...base,
    databaseUrl,
    serviceTokens: parseServiceTokens(reader.get('SERVICE_TOKENS')),
  };
}

import { EnvReader, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry } from '@nawara/service-kit';

/** The one identity of this service: logs, the kit's database `application_name` and event `source` later, Docker, documentation. */
export const SERVICE_NAME = 'notification-service';

/**
 * notification-service configuration, layered on the kit's shared `BaseConfig` (Stage 16.3). It carries ONLY what the foundation uses:
 * the HTTP baseline (port, log level, body limit, CORS, proxy trust, the bounded HTTP drain) and the accepted service callers.
 *
 * Deliberately absent until the stage that uses it (ADR-0046, Stage 16.1 roadmap): `DATABASE_URL` (16.4, persistence), `RABBITMQ_*`
 * (16.5, event intake), `NOTIFICATION_SERVICE_POLICY` and API docs (16.6, the send API), `NOTIFICATION_SECRET_KEYS` (16.5, sealed
 * one-time codes), worker and provider settings (16.7 / 16.8). The kit's `db` limits in `BaseConfig` are parsed (bounded defaults)
 * but unused until 16.4.
 */
export interface NotificationConfig extends BaseConfig {
  /**
   * Accepted callers, `<caller>:<sha256 digest>` (ADR-0033). Empty (the default) means every service-token call is refused: fail
   * closed. No route uses it yet; the send API (16.6) will.
   */
  serviceTokens: ServiceTokenEntry[];
}

/** Throws `ConfigError` (never echoing a value) on any missing or invalid setting, before anything starts. */
export function loadNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  const reader = new EnvReader(env);
  return {
    ...loadBaseConfig(SERVICE_NAME, env, reader),
    serviceTokens: parseServiceTokens(reader.get('SERVICE_TOKENS')),
  };
}

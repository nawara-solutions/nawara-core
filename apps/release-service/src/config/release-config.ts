import { ConfigError, EnvReader, loadBaseConfig, type BaseConfig } from '@nawara/service-kit';

/** The one identity of this service: logs, the database `application_name`, Docker, documentation. */
export const SERVICE_NAME = 'release-service';

/**
 * release-service configuration (ADR-0051), layered on the kit's shared `BaseConfig`. Stage 20.2 carries ONLY what the foundation uses:
 * the HTTP baseline and the database limits (from the kit), and the database itself (the least-privilege runtime role; readiness =
 * database + migrations).
 *
 * Deliberately absent until the stage that uses it: service tokens and the CI release policy (20.3), Auth verification and the owner's
 * step-up (20.4), the public compatibility read and its rate limit / cache (20.5). Never: channels, artifacts, signing keys, stores,
 * CDNs, feature flags, maintenance mode (ADR-0051 §12).
 */
export interface ReleaseConfig extends BaseConfig {
  /** Runtime connection: the least-privilege `release_app` role (ADR-0032), never the schema owner or a superuser. */
  databaseUrl: string;
}

/** Database users that must never run the service in production: the default superuser name and any schema-owner role. */
const FORBIDDEN_RUNTIME_DB_USER = /^(postgres|root|.+_migrator)$/;

/** Throws `ConfigError` (never echoing a value) on any missing or invalid setting, before anything starts. */
export function loadReleaseConfig(env: NodeJS.ProcessEnv = process.env): ReleaseConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig(SERVICE_NAME, env, reader);
  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  if (base.isProduction && FORBIDDEN_RUNTIME_DB_USER.test(decodeURIComponent(new URL(databaseUrl).username))) {
    // ADR-0032: the runtime role holds DML only. Refuse a superuser or schema-owner login rather than run with DDL rights.
    throw new ConfigError('DATABASE_URL must use the least-privilege runtime role in production, not a superuser or migrator role');
  }
  return { ...base, databaseUrl };
}

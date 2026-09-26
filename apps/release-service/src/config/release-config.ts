import {
  ConfigError, DEFAULT_RABBITMQ_HEARTBEAT_S, EnvReader, RABBITMQ_HEARTBEAT_BOUNDS, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry,
} from '@nawara/service-kit';
import { ReleaseCallerPolicy } from '../policy/caller-policy.js';

/** The one identity of this service: logs, the database `application_name`, Docker, documentation. */
export const SERVICE_NAME = 'release-service';

/**
 * release-service configuration (ADR-0051), layered on the kit's shared `BaseConfig`:
 * - Stage 20.2: the HTTP baseline and the database limits (from the kit), and the database itself (the least-privilege runtime role;
 *   readiness = database + migrations);
 * - Stage 20.3: the accepted service callers (`SERVICE_TOKENS`, ADR-0033) and their per-product policy (`RELEASE_SERVICE_POLICY`,
 *   ADR-0042), the broker the audit relay publishes to, and the OpenAPI documentation (behind basic auth).
 *
 * Deliberately absent until the stage that uses it: Auth verification and the owner's step-up (20.4), the public compatibility read and
 * its rate limit / cache (20.5). Never: channels, artifacts, signing keys, stores, CDNs, feature flags, maintenance mode (ADR-0051 §12).
 */
export interface ReleaseConfig extends BaseConfig {
  /** Runtime connection: the least-privilege `release_app` role (ADR-0032), never the schema owner or a superuser. */
  databaseUrl: string;
  /** Accepted callers, `<caller>:<sha256 digest>` (ADR-0033). Empty (the default) refuses every service-token call: fail closed. */
  serviceTokens: ServiceTokenEntry[];
  /** `RELEASE_SERVICE_POLICY`: which product each authenticated caller may register / publish for. Deny by default. */
  callerPolicy: ReleaseCallerPolicy;
  /** OpenAPI at `/release/docs`, behind basic auth, mounted only when `SWAGGER_PASSWORD` (16+ characters) is set. */
  docs: { username: string; password?: string };
  /**
   * Stage 20.3: the broker the kit relay publishes the audit intent to (the only events this service produces; it consumes none).
   * Required in production; elsewhere its absence selects the in-memory bus.
   */
  rabbitmqUrl?: string;
  rabbitmqConfirmTimeoutMs: number;
  rabbitmqHeartbeatS: number;
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
  const serviceTokens = parseServiceTokens(reader.get('SERVICE_TOKENS'));
  const rabbitmqUrl = reader.get('RABBITMQ_URL') === undefined ? undefined : reader.url('RABBITMQ_URL', ['amqp:', 'amqps:']);
  if (base.isProduction && rabbitmqUrl === undefined) {
    // Stage 20.3: the audit intent committed with every registration and publication must leave the service.
    throw new ConfigError('RABBITMQ_URL is required in production (the in-memory event bus is for development and tests only)');
  }
  return {
    ...base,
    databaseUrl,
    serviceTokens,
    callerPolicy: ReleaseCallerPolicy.parse(reader.get('RELEASE_SERVICE_POLICY'), [...new Set(serviceTokens.map((t) => t.caller))]),
    docs: {
      username: reader.optional('SWAGGER_USERNAME', 'docs') as string,
      password: reader.get('SWAGGER_PASSWORD') === undefined ? undefined : reader.secret('SWAGGER_PASSWORD', 16),
    },
    rabbitmqUrl,
    rabbitmqConfirmTimeoutMs: reader.int('RABBITMQ_CONFIRM_TIMEOUT_MS', { default: 5_000, min: 100, max: 60_000 }),
    rabbitmqHeartbeatS: reader.int('RABBITMQ_HEARTBEAT_S', { default: DEFAULT_RABBITMQ_HEARTBEAT_S, ...RABBITMQ_HEARTBEAT_BOUNDS }),
  };
}

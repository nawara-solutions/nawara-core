import { randomBytes } from 'node:crypto';
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
 * - Stage 20.4: owner administration (`ownerAdmin`): Auth's address and time budget, and the configured operating Company whose verified
 *   owner may withdraw releases and change minimum versions (ADR-0051 decision 8).
 *
 * - Stage 20.5: the public compatibility read (`compatibility`): its freshness (`Cache-Control: max-age`), the per-client rate limit and
 *   the key that hashes client addresses before they reach the limiter table. Never: channels, artifacts, signing keys, stores, CDNs, feature flags, maintenance mode (ADR-0051 §12).
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
  /**
   * Stage 20.4 (ADR-0051 decision 8, ADR-0050): the human administration routes exist only when ALL of `AUTH_SERVICE_URL`,
   * `RELEASE_OPERATING_COMPANY_ID` are set (a partial configuration refuses to boot). `AUTH_TIMEOUT_MS` (default 3000, 100–30000) is ONE
   * budget shared by every Auth call of a request (owner verification, then the step-up), so a slow Auth fails the request closed.
   */
  ownerAdmin?: { authServiceUrl: string; authTimeoutMs: number; operatingCompanyId: string };
  /**
   * Stage 20.5 (ADR-0051 decision 10), the public compatibility read:
   * - `maxAgeS` (`RELEASE_COMPATIBILITY_MAX_AGE_S`, default 60, 0–300): how long a decision may be reused, so a new `required` reaches every
   *   client within it. No stale-while-revalidate: a withdrawal must not be hidden longer than this.
   * - `ratePerClient` (`RELEASE_COMPATIBILITY_RATE_PER_CLIENT`, default 120, 1–100000): requests per client address per 60 s.
   * - `rateLimitKey` (`RELEASE_RATE_LIMIT_KEY`, base64, ≥ 32 bytes): keys client addresses before they reach the limiter table (an unkeyed
   *   IPv4 digest is reversible). Required in production; elsewhere a random per-process key is used when it is absent.
   */
  compatibility: { maxAgeS: number; ratePerClient: number; rateLimitKey: Buffer };
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
    ...ownerAdmin(reader),
    compatibility: {
      maxAgeS: reader.int('RELEASE_COMPATIBILITY_MAX_AGE_S', { default: 60, min: 0, max: 300 }),
      ratePerClient: reader.int('RELEASE_COMPATIBILITY_RATE_PER_CLIENT', { default: 120, min: 1, max: 100_000 }),
      rateLimitKey: rateLimitKey(reader, base.isProduction),
    },
  };
}

/** `RELEASE_RATE_LIMIT_KEY`: base64, at least 32 bytes (the File rule). Never echoed. */
function rateLimitKey(reader: EnvReader, isProduction: boolean): Buffer {
  const raw = reader.get('RELEASE_RATE_LIMIT_KEY');
  if (raw === undefined) {
    if (isProduction) throw new ConfigError('RELEASE_RATE_LIMIT_KEY is required in production (it keys client addresses for the public rate limit)');
    return randomBytes(32);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new ConfigError('RELEASE_RATE_LIMIT_KEY must be base64');
  const key = Buffer.from(raw, 'base64');
  if (key.length < 32) throw new ConfigError('RELEASE_RATE_LIMIT_KEY must decode to at least 32 bytes');
  return key;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stage 20.4: both settings or neither. Without them the owner routes are not mounted (nobody can withdraw or change a policy). */
function ownerAdmin(reader: EnvReader): Pick<ReleaseConfig, 'ownerAdmin'> {
  const hasUrl = reader.get('AUTH_SERVICE_URL') !== undefined;
  const hasCompany = reader.get('RELEASE_OPERATING_COMPANY_ID') !== undefined;
  if (!hasUrl && !hasCompany) return {};
  if (!hasUrl || !hasCompany) throw new ConfigError('AUTH_SERVICE_URL and RELEASE_OPERATING_COMPANY_ID are required together (owner administration), or neither');
  const company = (reader.get('RELEASE_OPERATING_COMPANY_ID') ?? '').toLowerCase();
  if (!UUID.test(company)) throw new ConfigError('RELEASE_OPERATING_COMPANY_ID must be a Company UUID');
  return {
    ownerAdmin: { authServiceUrl: authServiceUrl(reader), authTimeoutMs: reader.int('AUTH_TIMEOUT_MS', { default: 3_000, min: 100, max: 30_000 }), operatingCompanyId: company },
  };
}

/**
 * The destination of the owner's bearer (the Stage 19.4 rule): an `http:` / `https:` origin, optionally with a base path, and nothing else.
 * Embedded credentials, a query or a fragment are refused at startup (they would change what, or where, the bearer is sent). Never echoed.
 */
function authServiceUrl(reader: EnvReader): string {
  const v = reader.url('AUTH_SERVICE_URL', ['http:', 'https:']);
  const u = new URL(v);
  if (u.username || u.password || u.search || u.hash || v.includes('?') || v.includes('#')) {
    throw new ConfigError('AUTH_SERVICE_URL must be a plain http(s) origin, optionally with a path: no credentials, query or fragment');
  }
  return v;
}

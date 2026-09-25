import { ConfigError, EnvReader, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry } from '@nawara/service-kit';
import { AuditCallerPolicy } from '../policy/caller-policy.js';

/** The one identity of this service (Stage 18.1, A68): logs, the database `application_name`, Docker, documentation. */
export const SERVICE_NAME = 'audit-service';

/**
 * audit-service configuration, layered on the kit's shared `BaseConfig`. Stage 18.2 carries ONLY what the foundation uses or must
 * validate at boot:
 * - the HTTP baseline (port, drain, body limit, CORS, proxy trust, log level) and the database limits, from the kit;
 * - the database (the least-privilege runtime role; readiness = database + migrations);
 * - the accepted service callers (`SERVICE_TOKENS`) and their policy (`AUDIT_SERVICE_POLICY`, deny by default).
 *
 * Deliberately absent until the stage that uses it: the broker, queue, prefetch and retry settings (18.5), query page / window bounds
 * and rate limits (18.6), retention durations and the maintenance role (18.8). There is no Auth or Organization setting at all: Audit
 * never calls them (A36).
 */
export interface AuditConfig extends BaseConfig {
  /** Runtime connection: the least-privilege `audit_app` role (ADR-0032), never the schema owner or a superuser. */
  databaseUrl: string;
  /** Accepted callers, `<caller>:<sha256 digest>` (ADR-0033). Empty (the default) refuses every service-token call: fail closed. */
  serviceTokens: ServiceTokenEntry[];
  /** `AUDIT_SERVICE_POLICY`: what each authenticated caller may read. Deny by default. */
  callerPolicy: AuditCallerPolicy;
}

/** Database users that must never run the service in production: the default superuser name and any schema-owner role. */
const FORBIDDEN_RUNTIME_DB_USER = /^(postgres|root|.+_migrator)$/;

/** Throws `ConfigError` (never echoing a value) on any missing or invalid setting, before anything starts. */
export function loadAuditConfig(env: NodeJS.ProcessEnv = process.env): AuditConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig(SERVICE_NAME, env, reader);
  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  if (base.isProduction && FORBIDDEN_RUNTIME_DB_USER.test(decodeURIComponent(new URL(databaseUrl).username))) {
    // ADR-0032 and ADR-0049 (A23): the runtime role may only insert and read. Refuse a superuser or schema-owner login rather than run
    // an append-only store with DDL rights.
    throw new ConfigError('DATABASE_URL must use the least-privilege runtime role in production, not a superuser or migrator role');
  }
  const serviceTokens = parseServiceTokens(reader.get('SERVICE_TOKENS'));
  return {
    ...base,
    databaseUrl,
    serviceTokens,
    callerPolicy: AuditCallerPolicy.parse(reader.get('AUDIT_SERVICE_POLICY'), [...new Set(serviceTokens.map((t) => t.caller))]),
  };
}

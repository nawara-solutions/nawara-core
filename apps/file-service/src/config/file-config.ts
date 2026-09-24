import { ConfigError, EnvReader, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry } from '@nawara/service-kit';
import { FileCallerPolicy } from '../policy/caller-policy.js';
import { loadStorageConfig, type StorageConfig } from '../storage/storage-config.js';

/** The one identity of this service: logs, the database `application_name`, Docker, documentation. */
export const SERVICE_NAME = 'file-service';

/** 25 MiB: the V1 default ceiling for one file (ADR-0048, decision F29). */
export const DEFAULT_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** 100 MiB: the frozen upper bound of FILE_MAX_BYTES (F29). Larger media would need the deferred direct-to-storage path. */
export const FILE_MAX_BYTES_BOUND = 100 * 1024 * 1024;

/**
 * file-service configuration, layered on the kit's shared `BaseConfig`. Stage 17.2 carries ONLY what the foundation uses or must
 * validate at boot:
 * - the HTTP baseline (port, drain, body limit, CORS, proxy trust, log level) from the kit;
 * - the database (the least-privilege runtime role; readiness = database + migrations, ADR-0048 §8);
 * - the accepted service callers (`SERVICE_TOKENS`) and their policy (`FILE_SERVICE_POLICY`, validated against FILE_MAX_BYTES);
 * - FILE_MAX_BYTES (the global ceiling every caller's `maxBytes` must respect);
 * - Stage 17.4: the object store (`FILE_STORAGE_PROVIDER` and its settings; required, fail closed, filesystem refused in production).
 *
 * Deliberately absent until the stage that uses it: the attach window and the request-hash key (17.5), the ticket TTL (17.6).
 * Tickets need no secret (opaque random values, ADR-0048 F35).
 */
export interface FileConfig extends BaseConfig {
  /** Runtime connection: the least-privilege `file_app` role (ADR-0032), never the schema owner or a superuser. */
  databaseUrl: string;
  /** Accepted callers, `<caller>:<sha256 digest>` (ADR-0033). Empty (the default) refuses every service-token call: fail closed. */
  serviceTokens: ServiceTokenEntry[];
  /** `FILE_SERVICE_POLICY`: what each authenticated caller may do. Deny by default. */
  callerPolicy: FileCallerPolicy;
  /** `FILE_MAX_BYTES` (default 25 MiB, 1 byte to 100 MiB): the global ceiling for one file; enforced on uploads from Stage 17.5. */
  maxBytes: number;
  /** The object store (Stage 17.4). Validated here; never contacted at startup, never a readiness dependency. */
  storage: StorageConfig;
}

/** Database users that must never run the service in production: the default superuser name and any schema-owner role. */
const FORBIDDEN_RUNTIME_DB_USER = /^(postgres|root|.+_migrator)$/;

/** Throws `ConfigError` (never echoing a value) on any missing or invalid setting, before anything starts. */
export function loadFileConfig(env: NodeJS.ProcessEnv = process.env): FileConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig(SERVICE_NAME, env, reader);
  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  if (base.isProduction && FORBIDDEN_RUNTIME_DB_USER.test(decodeURIComponent(new URL(databaseUrl).username))) {
    // ADR-0032: the runtime role is DML-only. Refuse a superuser or schema-owner login rather than run with DDL rights.
    throw new ConfigError('DATABASE_URL must use the least-privilege runtime role in production, not a superuser or migrator role');
  }
  const serviceTokens = parseServiceTokens(reader.get('SERVICE_TOKENS'));
  const maxBytes = reader.int('FILE_MAX_BYTES', { default: DEFAULT_FILE_MAX_BYTES, min: 1, max: FILE_MAX_BYTES_BOUND });
  return {
    ...base,
    databaseUrl,
    serviceTokens,
    callerPolicy: FileCallerPolicy.parse(reader.get('FILE_SERVICE_POLICY'), [...new Set(serviceTokens.map((t) => t.caller))], maxBytes),
    maxBytes,
    storage: loadStorageConfig(reader, base.isProduction),
  };
}

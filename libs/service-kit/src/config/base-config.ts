import { ConfigError, EnvReader } from './config.js';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Configuration every Core service shares. Service-specific configuration is added by the service itself. */
export interface BaseConfig {
  serviceName: string;
  /** Defaults to `production` when NODE_ENV is unset: the safe behaviour (masked errors, no debug logs) is the default. */
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  logLevel: LogLevel;
  /** Maximum JSON request body, in kilobytes. */
  bodyLimitKb: number;
  /** Exact http(s) origins only. Empty means CORS is off. */
  corsOrigins: string[];
  trustProxy: boolean;
  /** Database pool and session limits (Stage 14.4), passed to `DbModule.forRoot`. Every value is bounded; none may be "infinite". */
  db: DbRuntimeConfig;
}

export interface DbRuntimeConfig {
  /** `DB_POOL_MAX`: connections per process (default 10, 1-100). */
  poolMax: number;
  /** `DB_CONNECTION_TIMEOUT_MS`: bound on getting a pooled client or opening a connection (default 5000, 100-60000). */
  connectionTimeoutMs: number;
  /** `DB_STATEMENT_TIMEOUT_MS`: PostgreSQL `statement_timeout` (default 30000, 1000-600000). */
  statementTimeoutMs: number;
  /** `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`: PostgreSQL `idle_in_transaction_session_timeout` (default 60000, 1000-3600000). */
  idleInTransactionTimeoutMs: number;
}

/** The database limits every Core service shares. Exported so a service with its own configuration loader can reuse the rule. */
export function loadDbRuntimeConfig(reader: EnvReader): DbRuntimeConfig {
  return {
    poolMax: reader.int('DB_POOL_MAX', { default: 10, min: 1, max: 100 }),
    connectionTimeoutMs: reader.int('DB_CONNECTION_TIMEOUT_MS', { default: 5_000, min: 100, max: 60_000 }),
    statementTimeoutMs: reader.int('DB_STATEMENT_TIMEOUT_MS', { default: 30_000, min: 1_000, max: 600_000 }),
    idleInTransactionTimeoutMs: reader.int('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', { default: 60_000, min: 1_000, max: 3_600_000 }),
  };
}

const SERVICE_NAME = /^[a-z][a-z0-9-]{1,62}$/;

export function parseCorsOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of origins) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(o);
    } catch {
      /* reported below */
    }
    // exact origins only: no wildcard, no path or trailing slash, http(s) scheme (a typo must fail closed, not open)
    if (o.includes('*') || !parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== o) {
      throw new ConfigError('CORS_ORIGINS entries must be exact origins such as https://app.example.com (wildcards, paths and other schemes are refused)');
    }
  }
  return origins;
}

export function loadBaseConfig(serviceName: string, env: NodeJS.ProcessEnv = process.env, reader = new EnvReader(env)): BaseConfig {
  if (!SERVICE_NAME.test(serviceName)) throw new ConfigError('service name must be lowercase letters, digits and dashes');
  const nodeEnv = reader.oneOf('NODE_ENV', NODE_ENVS, 'production');
  return {
    serviceName,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: reader.int('PORT', { default: 3000, min: 1, max: 65535 }),
    logLevel: reader.oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    bodyLimitKb: reader.int('BODY_LIMIT_KB', { default: 100, min: 1, max: 10_240 }),
    corsOrigins: parseCorsOrigins(reader.get('CORS_ORIGINS')),
    trustProxy: reader.bool('TRUST_PROXY', false),
    db: loadDbRuntimeConfig(reader),
  };
}

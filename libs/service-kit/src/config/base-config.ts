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
  };
}

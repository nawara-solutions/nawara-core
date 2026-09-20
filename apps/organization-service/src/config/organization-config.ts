import { ConfigError, EnvReader, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry } from '@nawara/service-kit';

/**
 * organization-service configuration, layered on the kit's shared `BaseConfig`. It carries ONLY what this service uses today.
 * There is deliberately no broker URL and no outbound service token: the service publishes nothing (ADR-0039). It DOES now
 * carry one bounded, narrow Auth dependency (`authServiceUrl`): the human-admin module (ADR-0042 decision 6 / Amendment 1)
 * forwards a caller's own bearer to Auth's `/auth/grants` and `/auth/step-up/verify` — never a service credential, never
 * anything outside that module (see boundary.spec.ts's admin-module carve-out).
 */
export interface OrganizationConfig extends BaseConfig {
  /** Runtime connection: the least-privilege `organization_app` role (ADR-0032), never the schema owner or a superuser. */
  databaseUrl: string;
  /** Accepted callers, `<caller>:<sha256 digest>` (ADR-0033). May be empty: every call is then refused (fail closed). */
  serviceTokens: ServiceTokenEntry[];
  /** The raw `SERVICE_POLICY` JSON (ADR-0042). Parsed and validated when the application module is built, i.e. at STARTUP: a registered caller with no entry refuses to boot. */
  servicePolicyRaw: string | undefined;
  /** Auth's base URL, used only by the human-admin module (ADR-0042 decision 6). */
  authServiceUrl: string;
  authTimeoutMs: number;
  /** OpenAPI is mounted at /organization/docs behind basic auth, and only when a password is configured. */
  docs: { username: string; password?: string };
}

/** Database users that must never run the service in production: the default superuser name and any schema-owner role. */
const FORBIDDEN_RUNTIME_DB_USER = /^(postgres|root|.+_migrator)$/;

export function loadOrganizationConfig(env: NodeJS.ProcessEnv = process.env): OrganizationConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig('organization-service', env, reader);

  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  if (base.isProduction && FORBIDDEN_RUNTIME_DB_USER.test(decodeURIComponent(new URL(databaseUrl).username))) {
    // ADR-0032: the runtime role is DML-only. Refuse a superuser or schema-owner login rather than run with DDL rights.
    throw new ConfigError('DATABASE_URL must use the least-privilege runtime role in production, not a superuser or migrator role');
  }

  return {
    ...base,
    databaseUrl,
    serviceTokens: parseServiceTokens(reader.get('SERVICE_TOKENS')),
    servicePolicyRaw: reader.get('SERVICE_POLICY'),
    authServiceUrl: reader.url('AUTH_SERVICE_URL', ['http:', 'https:']),
    authTimeoutMs: reader.int('AUTH_TIMEOUT_MS', { default: 3000, min: 100, max: 30_000 }),
    docs: {
      username: reader.optional('SWAGGER_USERNAME', 'docs') as string,
      // A password that protects API documentation of an authority service must not be trivial.
      password: reader.get('SWAGGER_PASSWORD') === undefined ? undefined : reader.secret('SWAGGER_PASSWORD', 16),
    },
  };
}

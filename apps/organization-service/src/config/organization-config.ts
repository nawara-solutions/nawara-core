import {
  ConfigError, DEFAULT_RABBITMQ_HEARTBEAT_S, EnvReader, RABBITMQ_HEARTBEAT_BOUNDS, assertRuntimeDatabaseRole, loadBaseConfig, parseServiceTokens, readDocsCredentials, type BaseConfig, type ServiceTokenEntry,
} from '@nawara/service-kit';

/**
 * organization-service configuration, layered on the kit's shared `BaseConfig`. It carries ONLY what this service uses today.
 * There is no outbound service token. Stage 18.7.3 adds the broker (`RABBITMQ_URL`) for ONE purpose: the kit relay publishes the service's
 * central audit outbox rows (ADR-0049); there are still no organization domain events. It DOES now
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
  /** `RABBITMQ_URL` (Stage 18.7.3; required in production, the in-memory bus otherwise): the relay of the central audit outbox. */
  rabbitmqUrl?: string;
  /** `RABBITMQ_CONFIRM_TIMEOUT_MS` (default 5000, 100–60000) and `RABBITMQ_HEARTBEAT_S` (default 10, 5–60): the kit bounds. */
  rabbitmqConfirmTimeoutMs: number;
  rabbitmqHeartbeatS: number;
}

export function loadOrganizationConfig(env: NodeJS.ProcessEnv = process.env): OrganizationConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig('organization-service', env, reader);

  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  // ADR-0032: the runtime role is DML-only; production refuses a superuser, schema-owner or bootstrap-admin login (V2 A2.2: the kit rule).
  assertRuntimeDatabaseRole(databaseUrl, { isProduction: base.isProduction });

  const rabbitmqUrl = reader.optional('RABBITMQ_URL');
  if (rabbitmqUrl !== undefined) reader.url('RABBITMQ_URL', ['amqp:', 'amqps:']);
  if (base.isProduction && rabbitmqUrl === undefined) {
    // Stage 18.7.3: the audit intent committed with every hierarchy write must reach the broker; the in-memory bus would drop it.
    throw new ConfigError('RABBITMQ_URL is required in production (the in-memory event bus is for development and tests only)');
  }

  return {
    ...base,
    databaseUrl,
    rabbitmqUrl,
    rabbitmqConfirmTimeoutMs: reader.int('RABBITMQ_CONFIRM_TIMEOUT_MS', { default: 5_000, min: 100, max: 60_000 }),
    rabbitmqHeartbeatS: reader.int('RABBITMQ_HEARTBEAT_S', { default: DEFAULT_RABBITMQ_HEARTBEAT_S, ...RABBITMQ_HEARTBEAT_BOUNDS }),
    serviceTokens: parseServiceTokens(reader.get('SERVICE_TOKENS')),
    servicePolicyRaw: reader.get('SERVICE_POLICY'),
    authServiceUrl: reader.url('AUTH_SERVICE_URL', ['http:', 'https:']),
    authTimeoutMs: reader.int('AUTH_TIMEOUT_MS', { default: 3000, min: 100, max: 30_000 }),
    // A password that protects API documentation of an authority service must not be trivial: at least 16 characters (the kit rule).
    docs: readDocsCredentials(reader),
  };
}

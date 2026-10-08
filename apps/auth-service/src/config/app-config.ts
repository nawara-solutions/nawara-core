import {
  ConfigError, DB_QUERY_TIMEOUT_BOUNDS, DB_QUERY_TIMEOUT_MARGIN_MS, DEFAULT_HTTP_DRAIN_TIMEOUT_MS, DEFAULT_RABBITMQ_HEARTBEAT_S, EnvReader,
  HTTP_DRAIN_TIMEOUT_BOUNDS, LOG_LEVELS, NODE_ENVS, RABBITMQ_HEARTBEAT_BOUNDS, assertDistinctKeys, assertRuntimeDatabaseRole, loadMetricsConfig,
  loadTrustProxyHops, parseCorsOrigins, readDocsCredentials, readKey, readKeyRing, readOptionalKey, readOptionalKeyEntries, type FileReader, type LogLevel, type MetricsConfig,
} from '@nawara/service-kit';

/**
 * All configuration and ALL secrets enter the service through this file, once, at startup.
 * Nothing else reads `process.env`. Secrets are never defaulted: a missing or weak secret makes
 * the process refuse to start (fail closed) rather than fall back to something guessable.
 *
 * V2 A4.2 (A4 record §6, OD-A4-2, OD-A4-3): every value is read through the kit's `EnvReader`, as in every other Core service. Any
 * variable may come from `NAME` or from a file `NAME_FILE` (the Docker/Kubernetes secret-mount convention); setting both is refused;
 * surrounding whitespace is removed and a blank value counts as unset. Tests inject an environment and, if they need to, a file reader.
 */

/** V2 A2.3 (OD-A2.3-1): the kit's class, so every configuration error, Auth's and the kit helpers', is one `ConfigError`. */
export { ConfigError };

export interface RateRule {
  /** Maximum hits per window. */
  limit: number;
  windowSec: number;
}

export type RateBucket =
  | 'login_ip'
  | 'login_identifier'
  | 'register_ip'
  | 'refresh_ip'
  | 'owner_verify_owner'
  | 'owner_verify_ip'
  | 'step_up_owner'
  | 'step_up_ip'
  | 'factor_enroll_owner'
  | 'recovery_ip'
  | 'recovery_identifier'
  | 'operator_request_identifier'
  | 'operator_request_ip'
  | 'operator_verify_identifier'
  | 'operator_verify_ip'
  | 'operator_verify_global'
  | 'operator_confirm_ip'
  | 'join_code_resolve_ip'
  | 'join_code_resolve_global'
  | 'join_code_manage_actor'
  | 'membership_op_actor'
  | 'membership_join_user'
  | 'contact_request_user'
  | 'contact_verify_user'
  | 'contact_verify_ip'
  | 'invitation_resolve_ip'
  | 'invitation_resolve_global'
  | 'invitation_accept_ip'
  | 'invitation_manage_actor';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  /** V2 A12.4.3: `LOG_LEVEL` (debug | info | warn | error, default `info`), read and validated exactly as every other Core service does. */
  logLevel: LogLevel;
  /** HTTP listen port. */
  port: number;
  /** Runtime connection. In production it must be the least-privilege runtime role (ADR-0032), never a superuser or the schema owner. */
  databaseUrl: string;
  /**
   * Database pool and session limits (Stage 14.4). Same names, defaults and bounds as the service-kit's `loadDbRuntimeConfig`:
   * DB_POOL_MAX (10, 1-100), DB_CONNECTION_TIMEOUT_MS (5000, 100-60000), DB_STATEMENT_TIMEOUT_MS (30000, 1000-600000),
   * DB_IDLE_IN_TRANSACTION_TIMEOUT_MS (60000, 1000-3600000), and (Stage 15.2) DB_QUERY_TIMEOUT_MS, the client-side deadline for a query's
   * answer (default statement timeout + 5000, 1000-660000, must exceed DB_STATEMENT_TIMEOUT_MS). Every value is bounded; none may be "infinite".
   */
  db: { poolMax: number; connectionTimeoutMs: number; statementTimeoutMs: number; idleInTransactionTimeoutMs: number; queryTimeoutMs: number };
  /** V2 A4.4: `BODY_LIMIT_KB`, the kit's variable, rule and default (100, 1-10240): the largest JSON or URL-encoded request body. */
  bodyLimitKb: number;
  /** `HTTP_DRAIN_TIMEOUT_MS` (Stage 15.5), same default and bounds as the kit: once shutdown starts, how long running requests may finish. */
  httpDrainTimeoutMs: number;
  /**
   * `AUTH_EVENTS` (Stage 21.C.2, ADR-0052 decision 4, Q4): whether Auth WRITES its domain-event rows into its transactional outbox. `off`
   * writes none (the production deploy sets it off until Stage 21.x enables it); anything else writes them in each change's transaction.
   * It never governs the relay: rows already committed are always published, and toggling never duplicates or replays an event. The
   * former fire-and-forget publisher and its separate broker connection are gone; the one relay below publishes domain events and audit
   * evidence alike.
   */
  events: { enabled: boolean };
  /**
   * Stage 21.C.2 (ADR-0040 decisions 1 and 2, A1.2; ADR-0042 A.3/A.5): where Auth's hierarchy facts come from. `local` (the default, and
   * the value until the 21.x cutover switches it): Auth's own tables are the authority, as today. `organization-service`: the tables are a
   * validated, non-authoritative reference cache; an administrative first touch (join code, invitation, platform assignment) places a
   * missing Company / Platform / Organization by `ensure`, bounded and fail closed. The switch is this configuration, never a code deploy.
   * `client` is Auth's own full-read credential at Organization Service (also used by the owner bootstrap of a fresh environment).
   * Login, refresh, logout, `/auth/me`, registration, join and consume NEVER call Organization Service.
   */
  hierarchy: { source: 'local' | 'organization-service'; client?: { baseUrl: string; token: string; timeoutMs: number } };
  /**
   * Stage 18.7.5: the outbox relay (the kit relay publishing `outbox` rows to RabbitMQ): audit evidence and, since Stage 21.C.2, domain
   * events. INDEPENDENT of `AUTH_EVENTS`: every committed row is always relayed. Production
   * requires `RABBITMQ_URL` (fail closed: evidence is never silently kept from Audit); elsewhere its absence selects the in-memory bus.
   * The relay connects lazily and retries: a broker outage never affects a request, the rows wait in the outbox.
   */
  audit: { rabbitmqUrl?: string; confirmTimeoutMs: number; heartbeatS: number };
  /** Stage 22 F3: `TRUST_PROXY_HOPS` (the kit rule; the deprecated `TRUST_PROXY=true` is one hop, never every hop). */
  trustProxyHops: number;
  corsOrigins: string[];
  /** V2 A12.2: METRICS_ENABLED (off), METRICS_HOST (loopback), METRICS_PORT (9464, never PORT); the kit's rule. */
  metrics: MetricsConfig;
  baselineRateLimitPerMinute: number;
  /**
   * V2 A4.7 (ADR-0058): `legacyKey` is `JWT_SECRET` (absent only once retired); `ring` is `JWT_SIGNING_KEYS` (empty when unset);
   * `activeKeyId` is `JWT_ACTIVE_KEY_ID`, or `legacy` (JWT_LEGACY_KEY_ID) when the ring is unset.
   */
  jwt: { legacyKey?: Uint8Array; ring: ReadonlyMap<string, Uint8Array>; activeKeyId: string; issuer: string; audience: string; accessTtlSec: number };
  refreshTtlSec: number;
  bcryptCost: number;
  secrets: {
    /** key id -> 32-byte AES-256 key. Several ids may coexist during a rotation. */
    totpKeys: Map<string, Buffer>;
    totpActiveKeyId: string;
    operatorCodePepper: Buffer;
    secretKeyPepper: Buffer;
    throttlePepper: Buffer;
    /** HMAC key for organization join codes (purpose-separated from every other secret). */
    joinCodePepper: Buffer;
  };
  totp: { issuer: string; epochToleranceSec: number };
  webauthn: { rpId: string; rpName: string; origins: string[] };
  challengeTtlSec: number;
  stepUp: { ttlSec: number };
  recovery: { cooldownSec: number; requestTtlSec: number; enrollmentTtlSec: number };
  operator: {
    timezone: string;
    fallbackSessionSec: number;
    confirmationTtlSec: number;
  };
  rate: Record<RateBucket, RateRule>;
  onboarding: {
    /** When true, organization access also requires a verified e-mail/phone. Off until a delivery channel exists. */
    requireContactVerification: boolean;
    contactCodeTtlSec: number;
    /** Admin-invitation lifetime bounds in MINUTES. The client only ever asks for a duration inside this range. */
    invitation: { minMinutes: number; defaultMinutes: number; maxMinutes: number };
  };
  /** Swagger UI at /auth/docs. Served only when a password is set (fail closed), behind basic auth. */
  docs: { username: string; password: string | undefined };
}

const MAX_STEP_UP_SEC = 900; // mirrors the owner_step_up CHECK (15 minutes)

/**
 * A browser only lets a page use an RP ID equal to its own host or a registrable parent of it, and the verifier compares origins
 * exactly: an origin outside the RP ID could never complete a ceremony. Refused at startup instead of at the first enrollment.
 * The origin must be exact (`https://admin.example.com`, no path) and its host the RP ID or a subdomain of it (`.`-bounded, so
 * `evilexample.com` is not under `example.com`).
 */
function assertOriginUnderRp(origin: string, rpId: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ConfigError('WEBAUTHN_ORIGINS entries must be exact origins such as https://admin.example.com');
  }
  if (url.origin !== origin) throw new ConfigError('WEBAUTHN_ORIGINS entries must be exact origins such as https://admin.example.com');
  const host = url.hostname.toLowerCase();
  const rp = rpId.toLowerCase();
  if (host !== rp && !host.endsWith(`.${rp}`)) {
    throw new ConfigError('every WEBAUTHN_ORIGINS host must be WEBAUTHN_RP_ID or a subdomain of it');
  }
}

function rule(reader: EnvReader, name: string, limit: number, windowSec: number): RateRule {
  return {
    limit: reader.int(`RATE_${name}_LIMIT`, { default: limit, min: 1, max: 1_000_000 }),
    windowSec: reader.int(`RATE_${name}_WINDOW_SEC`, { default: windowSec, min: 1, max: 86_400 }),
  };
}

/** The reserved `JWT_ACTIVE_KEY_ID` value meaning `JWT_SECRET` (ADR-0058 rule 1); refused as a ring id in any letter case. */
export const JWT_LEGACY_KEY_ID = 'legacy';
/** ADR-0058 rule 3 (D4). */
const JWT_RING_MAX_KEYS = 3;

/**
 * V2 A4.7 (ADR-0058 rules 1 to 3, A4 record §10.3). Neither ring variable set: exactly the former behaviour (`JWT_SECRET` required,
 * active `legacy`). Both set: the ring is active. Exactly one set: refused. Distinctness from every other purpose is checked by the caller.
 */
function readJwtKeys(reader: EnvReader, isProduction: boolean): { legacyKey?: Buffer; ring: Map<string, Buffer>; activeKeyId: string } {
  const legacyKey = readOptionalKey(reader, 'JWT_SECRET', { isProduction });
  const ring = readOptionalKeyEntries(reader, 'JWT_SIGNING_KEYS', { isProduction }, { maxEntries: JWT_RING_MAX_KEYS });
  const activeKeyId = reader.get('JWT_ACTIVE_KEY_ID');
  if ((ring === undefined) !== (activeKeyId === undefined)) throw new ConfigError('JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together');
  if (ring === undefined || activeKeyId === undefined) {
    if (legacyKey === undefined) reader.required('JWT_SECRET'); // the existing refusal: JWT_SECRET is required
    return { legacyKey, ring: new Map(), activeKeyId: JWT_LEGACY_KEY_ID };
  }
  if ([...ring.keys()].some((id) => id.toLowerCase() === JWT_LEGACY_KEY_ID)) {
    throw new ConfigError(`JWT_SIGNING_KEYS must not use the reserved key id ${JWT_LEGACY_KEY_ID}`);
  }
  if (activeKeyId === JWT_LEGACY_KEY_ID) {
    if (legacyKey === undefined) throw new ConfigError(`JWT_ACTIVE_KEY_ID is ${JWT_LEGACY_KEY_ID} but JWT_SECRET is not set`);
  } else if (!ring.has(activeKeyId)) {
    throw new ConfigError('JWT_ACTIVE_KEY_ID does not name a key in JWT_SIGNING_KEYS');
  }
  return { legacyKey, ring, activeKeyId };
}

/** `auth`: the database owner the production deploy creates (apps/auth-service/deploy/provision-and-deploy.sh); never the runtime role. */
const AUTH_DATABASE_OWNER = 'auth';

/** `readFile` is for tests only: the default reads `NAME_FILE` paths from disk. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, readFile?: FileReader): AppConfig {
  const reader = readFile ? new EnvReader(env, readFile) : new EnvReader(env);
  // V2 A2.3 (OD-A2.3-2): an unset NODE_ENV is production, the safe behaviour, as in every other Core service; anything else is refused.
  const nodeEnv: AppConfig['env'] = reader.oneOf('NODE_ENV', NODE_ENVS, 'production');
  const isProduction = nodeEnv === 'production';

  // The kit's key rules (V2 A2.3): canonical standard base64 of at least 32 bytes; in production, no development key published in this
  // repository and no key that does not look random. Never echoed.
  const jwt = readJwtKeys(reader, isProduction);
  // V2 A4.2: the kit's key ring (same id rule, size, repeat and active-id checks as Auth's former parser).
  const totp = readKeyRing(reader, 'TOTP_ENCRYPTION_KEYS', 'TOTP_ENCRYPTION_ACTIVE_KEY_ID', { isProduction, exactBytes: 32 });
  const operatorCodePepper = readKey(reader, 'OPERATOR_CODE_PEPPER', { isProduction });
  const secretKeyPepper = readKey(reader, 'SECRET_KEY_PEPPER', { isProduction });
  const throttlePepper = readKey(reader, 'THROTTLE_KEY_PEPPER', { isProduction });
  const joinCodePepper = readKey(reader, 'JOIN_CODE_PEPPER', { isProduction });

  // Domain separation: one compromised/leaked secret must not unlock another purpose (errors name the variables, never the material).
  assertDistinctKeys([
    ...(jwt.legacyKey ? [['JWT_SECRET', jwt.legacyKey] as const] : []),
    ...[...jwt.ring.values()].map((k) => ['JWT_SIGNING_KEYS', k] as const),
    ['OPERATOR_CODE_PEPPER', operatorCodePepper],
    ['SECRET_KEY_PEPPER', secretKeyPepper],
    ['THROTTLE_KEY_PEPPER', throttlePepper],
    ['JOIN_CODE_PEPPER', joinCodePepper],
    ...[...totp.keys.values()].map((k) => ['TOTP_ENCRYPTION_KEYS', k] as const),
  ]);

  const stepUpTtl = reader.int('STEP_UP_TTL_SEC', { default: 300, min: 30, max: MAX_STEP_UP_SEC });
  const origins = (reader.optional('WEBAUTHN_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const rpId = reader.optional('WEBAUTHN_RP_ID') ?? '';
  if (nodeEnv === 'production' && (!rpId || origins.length === 0)) {
    throw new ConfigError('WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS are required in production');
  }
  if (nodeEnv === 'production' && origins.some((o) => !o.startsWith('https://'))) {
    throw new ConfigError('WEBAUTHN_ORIGINS must be https:// origins in production');
  }
  if (nodeEnv === 'production') for (const o of origins) assertOriginUnderRp(o, rpId);
  // V2 A4.2: `DATABASE_URL_FILE` is accepted like any other variable; Auth's own messages are kept.
  const databaseUrl = reader.required('DATABASE_URL');
  let dbUrl: URL;
  try { dbUrl = new URL(databaseUrl); } catch { throw new ConfigError('DATABASE_URL must be a valid URL'); }
  if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol)) throw new ConfigError('DATABASE_URL must use postgres: or postgresql:');
  // ADR-0032: the runtime role is DML-only; production refuses a superuser, schema-owner, bootstrap-admin or the database-owner login
  // (V2 A2.3: the kit rule plus Auth's owner role).
  assertRuntimeDatabaseRole(databaseUrl, { isProduction, alsoForbidden: [AUTH_DATABASE_OWNER] });

  // V2 A2.3: exactly `on` (the default) or `off`; anything else is refused instead of silently meaning on.
  const eventsEnabled = reader.oneOf('AUTH_EVENTS', ['on', 'off'] as const, 'on') === 'on';

  // Stage 18.7.5: the relay's broker, read regardless of AUTH_EVENTS; the same variables and bounds as the other Core producers.
  // V2 A4.2: `RABBITMQ_URL_FILE` is accepted like any other variable.
  const auditRabbitmqUrl = reader.get('RABBITMQ_URL');
  if (auditRabbitmqUrl === undefined && nodeEnv === 'production') {
    throw new ConfigError('RABBITMQ_URL is required in production: the central audit relay publishes Auth\'s audit evidence (independent of AUTH_EVENTS)');
  }
  if (auditRabbitmqUrl !== undefined) {
    let parsed: URL | undefined;
    try { parsed = new URL(auditRabbitmqUrl); } catch { /* reported below */ }
    if (!parsed || !['amqp:', 'amqps:'].includes(parsed.protocol)) throw new ConfigError('RABBITMQ_URL must be a valid amqp:// or amqps:// URL');
  }
  const auditRelay = {
    rabbitmqUrl: auditRabbitmqUrl,
    confirmTimeoutMs: reader.int('RABBITMQ_CONFIRM_TIMEOUT_MS', { default: 5_000, min: 100, max: 60_000 }),
    heartbeatS: reader.int('RABBITMQ_HEARTBEAT_S', { default: DEFAULT_RABBITMQ_HEARTBEAT_S, ...RABBITMQ_HEARTBEAT_BOUNDS }),
  };

  const invitation = {
    minMinutes: reader.int('INVITATION_MIN_MINUTES', { default: 15, min: 1, max: 1440 }),
    defaultMinutes: reader.int('INVITATION_DEFAULT_MINUTES', { default: 1440, min: 1, max: 43_200 }),
    maxMinutes: reader.int('INVITATION_MAX_MINUTES', { default: 10_080, min: 1, max: 43_200 }), // hard ceiling 30 days = the database CHECK
  };
  if (!(invitation.minMinutes <= invitation.defaultMinutes && invitation.defaultMinutes <= invitation.maxMinutes)) {
    throw new ConfigError('INVITATION_MIN_MINUTES <= INVITATION_DEFAULT_MINUTES <= INVITATION_MAX_MINUTES must hold');
  }

  // V2 A2.3: the kit's exact-origin rule (the same rule), whose error never repeats the rejected entry.
  const corsOrigins = parseCorsOrigins(reader.get('CORS_ORIGINS'));

  // V2 A4.2: the kit helper (`SWAGGER_PASSWORD` at least 16 characters, `SWAGGER_USERNAME` default `docs`), as in the other services.
  const docs = readDocsCredentials(reader);

  const statementTimeoutMs = reader.int('DB_STATEMENT_TIMEOUT_MS', { default: 30_000, min: 1_000, max: 600_000 });
  const queryTimeoutMs = reader.int('DB_QUERY_TIMEOUT_MS', { default: statementTimeoutMs + DB_QUERY_TIMEOUT_MARGIN_MS, ...DB_QUERY_TIMEOUT_BOUNDS });
  if (queryTimeoutMs <= statementTimeoutMs) throw new ConfigError('DB_QUERY_TIMEOUT_MS must be greater than DB_STATEMENT_TIMEOUT_MS');

  const port = reader.int('PORT', { default: 3000, min: 1, max: 65_535 });
  return {
    env: nodeEnv,
    logLevel: reader.oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    port,
    databaseUrl,
    db: {
      poolMax: reader.int('DB_POOL_MAX', { default: 10, min: 1, max: 100 }),
      connectionTimeoutMs: reader.int('DB_CONNECTION_TIMEOUT_MS', { default: 5_000, min: 100, max: 60_000 }),
      statementTimeoutMs,
      idleInTransactionTimeoutMs: reader.int('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', { default: 60_000, min: 1_000, max: 3_600_000 }),
      queryTimeoutMs,
    },
    bodyLimitKb: reader.int('BODY_LIMIT_KB', { default: 100, min: 1, max: 10_240 }),
    httpDrainTimeoutMs: reader.int('HTTP_DRAIN_TIMEOUT_MS', { default: DEFAULT_HTTP_DRAIN_TIMEOUT_MS, ...HTTP_DRAIN_TIMEOUT_BOUNDS }),
    events: { enabled: eventsEnabled },
    hierarchy: loadHierarchy(reader),
    audit: auditRelay,
    trustProxyHops: loadTrustProxyHops(reader),
    corsOrigins,
    metrics: loadMetricsConfig(reader, port, nodeEnv),
    baselineRateLimitPerMinute: reader.int('BASELINE_RATE_LIMIT_PER_MINUTE', { default: 100, min: 1, max: 1_000_000 }),
    jwt: {
      ...(jwt.legacyKey ? { legacyKey: new Uint8Array(jwt.legacyKey) } : {}),
      ring: new Map([...jwt.ring].map(([id, k]) => [id, new Uint8Array(k)])),
      activeKeyId: jwt.activeKeyId,
      issuer: reader.optional('JWT_ISSUER', 'nawara-auth') as string,
      audience: reader.optional('JWT_AUDIENCE', 'nawara') as string,
      accessTtlSec: reader.int('ACCESS_TOKEN_TTL_SEC', { default: 900, min: 30, max: 3600 }),
    },
    refreshTtlSec: reader.int('REFRESH_TOKEN_TTL_SEC', { default: 14 * 86_400, min: 60, max: 90 * 86_400 }),
    bcryptCost: reader.int('BCRYPT_COST', { default: 12, min: 4, max: 15 }),
    secrets: { totpKeys: totp.keys, totpActiveKeyId: totp.activeKeyId, operatorCodePepper, secretKeyPepper, throttlePepper, joinCodePepper },
    totp: {
      issuer: reader.optional('TOTP_ISSUER', 'Nawara') as string,
      epochToleranceSec: reader.int('TOTP_EPOCH_TOLERANCE_SEC', { default: 30, min: 0, max: 60 }),
    },
    webauthn: {
      rpId: rpId || 'localhost',
      rpName: reader.optional('WEBAUTHN_RP_NAME', 'Nawara') as string,
      origins: origins.length ? origins : ['http://localhost:3000'],
    },
    challengeTtlSec: reader.int('CHALLENGE_TTL_SEC', { default: 600, min: 30, max: 1800 }),
    stepUp: { ttlSec: stepUpTtl },
    recovery: {
      cooldownSec: reader.int('RECOVERY_COOLDOWN_SEC', { default: 86_400, min: 1, max: 30 * 86_400 }),
      requestTtlSec: reader.int('RECOVERY_REQUEST_TTL_SEC', { default: 7 * 86_400, min: 60, max: 60 * 86_400 }),
      enrollmentTtlSec: reader.int('RECOVERY_ENROLLMENT_TTL_SEC', { default: 1800, min: 60, max: 1800 }),
    },
    operator: {
      timezone: reader.optional('WORK_TIMEZONE', 'UTC') as string,
      fallbackSessionSec: reader.int('OPERATOR_FALLBACK_SESSION_SEC', { default: 8 * 3600, min: 60, max: 24 * 3600 }),
      confirmationTtlSec: reader.int('OPERATOR_CONFIRMATION_TTL_SEC', { default: 8 * 3600, min: 60, max: 7 * 86_400 }),
    },
    // Defaults are deliberately conservative starting points, all overridable per deployment.
    rate: {
      login_ip: rule(reader, 'LOGIN_IP', 60, 900),
      login_identifier: rule(reader, 'LOGIN_IDENTIFIER', 10, 900),
      register_ip: rule(reader, 'REGISTER_IP', 20, 3600),
      refresh_ip: rule(reader, 'REFRESH_IP', 120, 900),
      owner_verify_owner: rule(reader, 'OWNER_VERIFY_OWNER', 8, 300),
      owner_verify_ip: rule(reader, 'OWNER_VERIFY_IP', 30, 300),
      step_up_owner: rule(reader, 'STEP_UP_OWNER', 10, 300),
      step_up_ip: rule(reader, 'STEP_UP_IP', 30, 300),
      factor_enroll_owner: rule(reader, 'FACTOR_ENROLL_OWNER', 10, 3600),
      recovery_ip: rule(reader, 'RECOVERY_IP', 10, 3600),
      recovery_identifier: rule(reader, 'RECOVERY_IDENTIFIER', 5, 3600),
      operator_request_identifier: rule(reader, 'OPERATOR_REQUEST_IDENTIFIER', 5, 3600),
      operator_request_ip: rule(reader, 'OPERATOR_REQUEST_IP', 30, 3600),
      // Per-operator, independent of IP: an attacker rotating IPs still hits this one.
      operator_verify_identifier: rule(reader, 'OPERATOR_VERIFY_IDENTIFIER', 10, 900),
      operator_verify_ip: rule(reader, 'OPERATOR_VERIFY_IP', 40, 900),
      // Coarse global brake on distributed guessing across many operators.
      operator_verify_global: rule(reader, 'OPERATOR_VERIFY_GLOBAL', 600, 60),
      operator_confirm_ip: rule(reader, 'OPERATOR_CONFIRM_IP', 30, 900),
      // Join codes are onboarding credentials: resolution is throttled per IP and by a global brake so a
      // botnet cannot enumerate the code space, and every failure looks identical to the caller.
      join_code_resolve_ip: rule(reader, 'JOIN_CODE_RESOLVE_IP', 20, 900),
      join_code_resolve_global: rule(reader, 'JOIN_CODE_RESOLVE_GLOBAL', 1000, 60),
      join_code_manage_actor: rule(reader, 'JOIN_CODE_MANAGE_ACTOR', 30, 3600),
      membership_op_actor: rule(reader, 'MEMBERSHIP_OP_ACTOR', 120, 900),
      membership_join_user: rule(reader, 'MEMBERSHIP_JOIN_USER', 10, 3600),
      contact_request_user: rule(reader, 'CONTACT_REQUEST_USER', 5, 3600),
      contact_verify_user: rule(reader, 'CONTACT_VERIFY_USER', 10, 900),
      contact_verify_ip: rule(reader, 'CONTACT_VERIFY_IP', 40, 900),
      // Admin invitations grant a privileged capability: resolution/acceptance are throttled harder than join codes.
      invitation_resolve_ip: rule(reader, 'INVITATION_RESOLVE_IP', 15, 900),
      invitation_resolve_global: rule(reader, 'INVITATION_RESOLVE_GLOBAL', 500, 60),
      invitation_accept_ip: rule(reader, 'INVITATION_ACCEPT_IP', 10, 900),
      invitation_manage_actor: rule(reader, 'INVITATION_MANAGE_ACTOR', 20, 3600),
    },
    onboarding: {
      // V2 A2.3: exactly `true` or `false` (default false); an ambiguous value is refused instead of silently turning verification off.
      requireContactVerification: reader.bool('REQUIRE_CONTACT_VERIFICATION', false),
      contactCodeTtlSec: reader.int('CONTACT_CODE_TTL_SEC', { default: 900, min: 60, max: 3600 }),
      invitation: invitation,
    },
    docs: { username: docs.username, password: docs.password },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Stage 21.C.2: `AUTH_HIERARCHY_SOURCE` and Auth's Organization Service credential. Errors never echo a value. */
function loadHierarchy(reader: EnvReader): AppConfig['hierarchy'] {
  const source = reader.optional('AUTH_HIERARCHY_SOURCE', 'local');
  if (source !== 'local' && source !== 'organization-service') throw new ConfigError('AUTH_HIERARCHY_SOURCE must be "local" or "organization-service"');
  const url = reader.get('ORGANIZATION_SERVICE_URL');
  const token = reader.get('ORGANIZATION_SERVICE_TOKEN');
  if ((url === undefined) !== (token === undefined)) throw new ConfigError('ORGANIZATION_SERVICE_URL and ORGANIZATION_SERVICE_TOKEN must be set together');
  if (source === 'organization-service' && url === undefined) throw new ConfigError('AUTH_HIERARCHY_SOURCE=organization-service needs ORGANIZATION_SERVICE_URL and ORGANIZATION_SERVICE_TOKEN');
  if (url === undefined || token === undefined) return { source };
  let parsed: URL | undefined;
  try { parsed = new URL(url); } catch { /* reported below */ }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw new ConfigError('ORGANIZATION_SERVICE_URL must be a valid http:// or https:// URL');
  if (token.length < 32) throw new ConfigError('ORGANIZATION_SERVICE_TOKEN must be at least 32 characters (a generated service token)');
  return { source, client: { baseUrl: url, token, timeoutMs: reader.int('ORGANIZATION_SERVICE_TIMEOUT_MS', { default: 2000, min: 100, max: 10_000 }) } };
}

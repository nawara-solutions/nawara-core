import {
  ConfigError, DEFAULT_RABBITMQ_HEARTBEAT_S, EnvReader, RABBITMQ_HEARTBEAT_BOUNDS, assertRuntimeDatabaseRole, loadBaseConfig, parseServiceTokens, readDocsCredentials, readKeyRing, type BaseConfig, type ServiceTokenEntry,
} from '@nawara/service-kit';
import { AUDIT_ENFORCEMENT_MODES, type AuditEnforcementMode } from '../ingestion/trust-policy.js';
import { AuditCallerPolicy } from '../policy/caller-policy.js';

/** The one identity of this service (Stage 18.1, A68): logs, the database `application_name`, Docker, documentation. */
export const SERVICE_NAME = 'audit-service';

/**
 * audit-service configuration, layered on the kit's shared `BaseConfig`. Stage 18.2 carries ONLY what the foundation uses or must
 * validate at boot:
 * - the HTTP baseline (port, drain, body limit, CORS, proxy trust, log level) and the database limits, from the kit;
 * - the database (the least-privilege runtime role; readiness = database + migrations);
 * - the accepted service callers (`SERVICE_TOKENS`) and their policy (`AUDIT_SERVICE_POLICY`, deny by default);
 * - Stage 18.5: the broker the ingestion consumes from (`RABBITMQ_URL`, required: ingestion is the service's primary job) and its two
 *   kit bounds. The queue, bindings, prefetch and retry are NOT settings: the queue and binding are the architecture's (A20), the
 *   prefetch derives from the pool, the retry is the kit's default.
 *
 * - Stage 18.6: the query rate limits (per 60 s window) and the optional OpenAPI credentials. The page size (≤ 100) and the time windows
 *   (92 / 31 days) are the architecture's (A66), not settings.
 *
 * Deliberately absent until the stage that uses it: retention durations and the maintenance role (18.8). There is no Organization
 * setting: Audit never calls it. Stage 19.3 (ADR-0050 decision 6, amending A36b for ONE read path): `AUTH_SERVICE_URL`, optional; only the
 * Company owner's organization read calls Auth, with the owner's own bearer. Ingestion and service-token reads never do.
 */
export interface AuditConfig extends BaseConfig {
  /** Runtime connection: the least-privilege `audit_app` role (ADR-0032), never the schema owner or a superuser. */
  databaseUrl: string;
  /** Accepted callers, `<caller>:<sha256 digest>` (ADR-0033). Empty (the default) refuses every service-token call: fail closed. */
  serviceTokens: ServiceTokenEntry[];
  /** `AUDIT_SERVICE_POLICY`: what each authenticated caller may read. Deny by default. */
  callerPolicy: AuditCallerPolicy;
  /** `RABBITMQ_URL` (required, `amqp:` / `amqps:`): the broker of the ingestion consumer. Never logged or echoed. */
  rabbitmqUrl: string;
  /** `RABBITMQ_CONFIRM_TIMEOUT_MS` (default 5000, 100–60000): bound on the confirm of the kit's retry / dead-letter copies. */
  rabbitmqConfirmTimeoutMs: number;
  /** `RABBITMQ_HEARTBEAT_S` (default 10, 5–60): a silent broker is detected within about 3 × this. */
  rabbitmqHeartbeatS: number;
  /**
   * Core V2 S1e-3 (ADR-0057 "S0-C6"): `AUDIT_PROVENANCE_ENFORCEMENT`, `compatibility` (the default: Audit's temporary compatibility phase,
   * what production runs until the Owner authorizes its exit) or `strict` (verified deliveries only; selected explicitly). Any other value
   * refuses to start: there is no observe-only or unenforced mode. See `ingestion/trust-policy.ts`.
   */
  provenanceEnforcement: AuditEnforcementMode;
  /**
   * Stage 18.6 query rate limits, requests per caller per 60 s (A66), every attempt by an authorized caller counted:
   * `AUDIT_QUERY_RATE_PER_CALLER` (organization scope, all organizations together; default 600), `AUDIT_QUERY_RATE_PER_ORGANIZATION`
   * (organization scope, one caller and one organization; default 120; ≤ the per-caller limit), `AUDIT_PLATFORM_QUERY_RATE_PER_CALLER`
   * (platform scope; default 30). Bounds 1–100000.
   */
  queryRates: { perCaller: number; perOrganization: number; platformPerCaller: number };
  /**
   * Stage 19.3 Audit-X: the owner read (`GET /audit/owner/organizations/{id}/records`) exists only when `AUTH_SERVICE_URL` (`http:` /
   * `https:`) is set; without it the route is not mounted and Audit calls no other service. `AUDIT_OWNER_QUERY_RATE_PER_OWNER` (default 30,
   * 1–100000): requests per verified owner per 60 s. `AUTH_TIMEOUT_MS` (default 3000, 100–30000): a slower Auth fails the read closed.
   */
  ownerAccess?: { authServiceUrl: string; ratePerOwner: number; authTimeoutMs: number };
  /**
   * Core V2 S2-Audit.3 (AUD-03, AUD-04; OD-14 cursor requirements): the scoped human reads, mounted ONLY when `AUDIT_CURSOR_KEYS` is set
   * (and then `AUTH_SERVICE_URL` is required: authority is always Auth's live answer). `AUDIT_CURSOR_KEYS` = `id:base64(32 bytes)[,…]`, a
   * key ring dedicated to cursor authentication (never another secret; two ids during a rotation), `AUDIT_CURSOR_ACTIVE_KEY_ID` the one
   * that signs. `AUDIT_CURSOR_TTL_SEC` (default 900, the access-token lifetime convention; 60–3600): a cursor older than this is refused.
   * `AUDIT_OPERATOR_QUERY_RATE_PER_OPERATOR` (default 30, 1–100000): requests per verified operator per 60 s.
   */
  scopedAccess?: { cursorKeys: ReadonlyMap<string, Buffer>; cursorActiveKeyId: string; cursorTtlSec: number; ratePerOperator: number };
  /** OpenAPI at `/audit/docs`, behind basic auth, mounted only when `SWAGGER_PASSWORD` (16+ characters) is set. */
  docs: { username: string; password?: string };
}

/** Throws `ConfigError` (never echoing a value) on any missing or invalid setting, before anything starts. */
export function loadAuditConfig(env: NodeJS.ProcessEnv = process.env): AuditConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig(SERVICE_NAME, env, reader);
  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  // ADR-0032 and ADR-0049 (A23): the runtime role may only insert and read; production refuses a superuser, schema-owner or
  // bootstrap-admin login (V2 A2.2: the kit rule).
  assertRuntimeDatabaseRole(databaseUrl, { isProduction: base.isProduction });
  const serviceTokens = parseServiceTokens(reader.get('SERVICE_TOKENS'));
  return {
    ...base,
    databaseUrl,
    serviceTokens,
    callerPolicy: AuditCallerPolicy.parse(reader.get('AUDIT_SERVICE_POLICY'), [...new Set(serviceTokens.map((t) => t.caller))]),
    rabbitmqUrl: reader.url('RABBITMQ_URL', ['amqp:', 'amqps:']),
    rabbitmqConfirmTimeoutMs: reader.int('RABBITMQ_CONFIRM_TIMEOUT_MS', { default: 5_000, min: 100, max: 60_000 }),
    rabbitmqHeartbeatS: reader.int('RABBITMQ_HEARTBEAT_S', { default: DEFAULT_RABBITMQ_HEARTBEAT_S, ...RABBITMQ_HEARTBEAT_BOUNDS }),
    provenanceEnforcement: reader.oneOf('AUDIT_PROVENANCE_ENFORCEMENT', AUDIT_ENFORCEMENT_MODES, 'compatibility'),
    queryRates: queryRates(reader),
    ...(reader.get('AUTH_SERVICE_URL') === undefined ? {} : {
      ownerAccess: {
        authServiceUrl: authServiceUrl(reader),
        ratePerOwner: reader.int('AUDIT_OWNER_QUERY_RATE_PER_OWNER', { default: 30, min: 1, max: 100_000 }),
        authTimeoutMs: reader.int('AUTH_TIMEOUT_MS', { default: 3_000, min: 100, max: 30_000 }),
      },
    }),
    ...scopedAccess(reader, base.isProduction),
    docs: readDocsCredentials(reader),
  };
}

/** Core V2 S2-Audit.3: the cursor key ring and the scoped-read bounds; absent unless `AUDIT_CURSOR_KEYS` is set. Errors never echo a key. */
function scopedAccess(reader: EnvReader, isProduction: boolean): Pick<AuditConfig, 'scopedAccess'> {
  if (reader.get('AUDIT_CURSOR_KEYS') === undefined) return {};
  if (reader.get('AUTH_SERVICE_URL') === undefined) {
    throw new ConfigError('AUDIT_CURSOR_KEYS needs AUTH_SERVICE_URL: the scoped reads are authorized only by Auth\'s live answer');
  }
  const ring = readKeyRing(reader, 'AUDIT_CURSOR_KEYS', 'AUDIT_CURSOR_ACTIVE_KEY_ID', { isProduction, exactBytes: 32 });
  return {
    scopedAccess: {
      cursorKeys: ring.keys, cursorActiveKeyId: ring.activeKeyId,
      cursorTtlSec: reader.int('AUDIT_CURSOR_TTL_SEC', { default: 900, min: 60, max: 3600 }),
      ratePerOperator: reader.int('AUDIT_OPERATOR_QUERY_RATE_PER_OPERATOR', { default: 30, min: 1, max: 100_000 }),
    },
  };
}

/**
 * Stage 19.4: the destination of the owner's bearer. An `http:` / `https:` origin (optionally with a base path) and nothing else: embedded
 * credentials, a query or a fragment are refused at startup (they would change what, or where, the bearer is sent). The value is never echoed.
 */
function authServiceUrl(reader: EnvReader): string {
  const v = reader.url('AUTH_SERVICE_URL', ['http:', 'https:']);
  const u = new URL(v);
  if (u.username || u.password || u.search || u.hash || v.includes('?') || v.includes('#')) {
    throw new ConfigError('AUTH_SERVICE_URL must be a plain http(s) origin, optionally with a path: no credentials, query or fragment');
  }
  return v;
}

function queryRates(reader: EnvReader): AuditConfig['queryRates'] {
  const bounds = { min: 1, max: 100_000 };
  const perCaller = reader.int('AUDIT_QUERY_RATE_PER_CALLER', { default: 600, ...bounds });
  const perOrganization = reader.int('AUDIT_QUERY_RATE_PER_ORGANIZATION', { default: 120, ...bounds });
  if (perOrganization > perCaller) throw new ConfigError('AUDIT_QUERY_RATE_PER_ORGANIZATION must not exceed AUDIT_QUERY_RATE_PER_CALLER');
  return { perCaller, perOrganization, platformPerCaller: reader.int('AUDIT_PLATFORM_QUERY_RATE_PER_CALLER', { default: 30, ...bounds }) };
}

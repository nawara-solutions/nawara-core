import { readFileSync } from 'node:fs';

/**
 * All configuration and ALL secrets enter the service through this file, once, at startup.
 * Nothing else reads `process.env`. Secrets are never defaulted: a missing or weak secret makes
 * the process refuse to start (fail closed) rather than fall back to something guessable.
 *
 * Secret sources, in order: `NAME` (env) or `NAME_FILE` (path to a file — the Docker/Kubernetes
 * secret-mount convention, and how a KMS/Vault sidecar hands values to a process). A KMS-backed
 * deployment plugs in by implementing `SecretSource` and passing it to `loadConfig`.
 */
export interface SecretSource {
  get(name: string): string | undefined;
}

export class EnvSecretSource implements SecretSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  get(name: string): string | undefined {
    const file = this.env[`${name}_FILE`];
    if (file) return readFileSync(file, 'utf8').trim();
    const v = this.env[name];
    return v === undefined || v === '' ? undefined : v;
  }
}

export class ConfigError extends Error {}

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
  | 'contact_request_user'
  | 'contact_verify_user'
  | 'contact_verify_ip'
  | 'invitation_resolve_ip'
  | 'invitation_resolve_global'
  | 'invitation_accept_ip'
  | 'invitation_manage_actor';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  databaseUrl: string;
  trustProxy: boolean;
  corsOrigins: string[];
  baselineRateLimitPerMinute: number;
  jwt: { secret: Uint8Array; issuer: string; audience: string; accessTtlSec: number };
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
  payment: { baseUrl: string; serviceToken: string; timeoutMs: number };
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

function int(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function required(src: SecretSource, name: string): string {
  const v = src.get(name);
  if (!v) throw new ConfigError(`${name} is required`);
  return v;
}

/** Decodes a base64 secret and enforces a minimum entropy size. Never echoes the value. */
function secretBytes(src: SecretSource, name: string, minBytes = 32): Buffer {
  const b = Buffer.from(required(src, name), 'base64');
  if (b.length < minBytes) {
    throw new ConfigError(`${name} must be base64 of at least ${minBytes} random bytes`);
  }
  return b;
}

function rule(env: NodeJS.ProcessEnv, name: string, limit: number, windowSec: number): RateRule {
  return {
    limit: int(env, `RATE_${name}_LIMIT`, limit, 1, 1_000_000),
    windowSec: int(env, `RATE_${name}_WINDOW_SEC`, windowSec, 1, 86_400),
  };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  src: SecretSource = new EnvSecretSource(env),
): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['env'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new ConfigError('NODE_ENV must be development, test or production');
  }

  const jwtSecret = secretBytes(src, 'JWT_SECRET');
  const totpKeys = new Map<string, Buffer>();
  for (const pair of required(src, 'TOTP_ENCRYPTION_KEYS').split(',')) {
    const i = pair.indexOf(':');
    const id = pair.slice(0, i).trim();
    const key = Buffer.from(pair.slice(i + 1).trim(), 'base64');
    if (i < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || key.length !== 32) {
      throw new ConfigError('TOTP_ENCRYPTION_KEYS must be "id:base64(32 bytes)[,id:base64(32 bytes)]"');
    }
    totpKeys.set(id, key);
  }
  const totpActiveKeyId = required(src, 'TOTP_ENCRYPTION_ACTIVE_KEY_ID');
  if (!totpKeys.has(totpActiveKeyId)) {
    throw new ConfigError('TOTP_ENCRYPTION_ACTIVE_KEY_ID does not name a key in TOTP_ENCRYPTION_KEYS');
  }
  const operatorCodePepper = secretBytes(src, 'OPERATOR_CODE_PEPPER');
  const secretKeyPepper = secretBytes(src, 'SECRET_KEY_PEPPER');
  const throttlePepper = secretBytes(src, 'THROTTLE_KEY_PEPPER');
  const joinCodePepper = secretBytes(src, 'JOIN_CODE_PEPPER');

  // Domain separation: one compromised/leaked secret must not unlock another purpose.
  const distinct = new Set(
    [jwtSecret, operatorCodePepper, secretKeyPepper, throttlePepper, joinCodePepper, ...totpKeys.values()].map((b) => b.toString('hex')),
  );
  if (distinct.size !== 5 + totpKeys.size) {
    throw new ConfigError('every secret (JWT, peppers, TOTP keys) must be distinct');
  }

  const stepUpTtl = int(env, 'STEP_UP_TTL_SEC', 300, 30, MAX_STEP_UP_SEC);
  const origins = (env.WEBAUTHN_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const rpId = env.WEBAUTHN_RP_ID ?? '';
  if (nodeEnv === 'production' && (!rpId || origins.length === 0)) {
    throw new ConfigError('WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS are required in production');
  }
  if (nodeEnv === 'production' && origins.some((o) => !o.startsWith('https://'))) {
    throw new ConfigError('WEBAUTHN_ORIGINS must be https:// origins in production');
  }
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');
  const payToken = src.get('PAYMENT_SERVICE_TOKEN') ?? '';
  if (nodeEnv === 'production' && payToken.length < 32) {
    throw new ConfigError('PAYMENT_SERVICE_TOKEN (>= 32 chars) is required in production');
  }

  const invitation = {
    minMinutes: int(env, 'INVITATION_MIN_MINUTES', 15, 1, 1440),
    defaultMinutes: int(env, 'INVITATION_DEFAULT_MINUTES', 1440, 1, 43_200),
    maxMinutes: int(env, 'INVITATION_MAX_MINUTES', 10_080, 1, 43_200), // hard ceiling 30 days = the database CHECK
  };
  if (!(invitation.minMinutes <= invitation.defaultMinutes && invitation.defaultMinutes <= invitation.maxMinutes)) {
    throw new ConfigError('INVITATION_MIN_MINUTES <= INVITATION_DEFAULT_MINUTES <= INVITATION_MAX_MINUTES must hold');
  }

  const docsPassword = src.get('SWAGGER_PASSWORD');
  if (docsPassword !== undefined && docsPassword.length < 16) {
    throw new ConfigError('SWAGGER_PASSWORD must be at least 16 characters');
  }

  return {
    env: nodeEnv,
    databaseUrl,
    trustProxy: env.TRUST_PROXY === 'true',
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    baselineRateLimitPerMinute: int(env, 'BASELINE_RATE_LIMIT_PER_MINUTE', 100, 1, 1_000_000),
    jwt: {
      secret: new Uint8Array(jwtSecret),
      issuer: env.JWT_ISSUER ?? 'nawara-auth',
      audience: env.JWT_AUDIENCE ?? 'nawara',
      accessTtlSec: int(env, 'ACCESS_TOKEN_TTL_SEC', 900, 30, 3600),
    },
    refreshTtlSec: int(env, 'REFRESH_TOKEN_TTL_SEC', 14 * 86_400, 60, 90 * 86_400),
    bcryptCost: int(env, 'BCRYPT_COST', 12, 4, 15),
    secrets: { totpKeys, totpActiveKeyId, operatorCodePepper, secretKeyPepper, throttlePepper, joinCodePepper },
    totp: { issuer: env.TOTP_ISSUER ?? 'Nawara', epochToleranceSec: int(env, 'TOTP_EPOCH_TOLERANCE_SEC', 30, 0, 60) },
    webauthn: {
      rpId: rpId || 'localhost',
      rpName: env.WEBAUTHN_RP_NAME ?? 'Nawara',
      origins: origins.length ? origins : ['http://localhost:3000'],
    },
    challengeTtlSec: int(env, 'CHALLENGE_TTL_SEC', 600, 30, 1800),
    stepUp: { ttlSec: stepUpTtl },
    recovery: {
      cooldownSec: int(env, 'RECOVERY_COOLDOWN_SEC', 86_400, 1, 30 * 86_400),
      requestTtlSec: int(env, 'RECOVERY_REQUEST_TTL_SEC', 7 * 86_400, 60, 60 * 86_400),
      enrollmentTtlSec: int(env, 'RECOVERY_ENROLLMENT_TTL_SEC', 1800, 60, 1800),
    },
    operator: {
      timezone: env.WORK_TIMEZONE ?? 'UTC',
      fallbackSessionSec: int(env, 'OPERATOR_FALLBACK_SESSION_SEC', 8 * 3600, 60, 24 * 3600),
      confirmationTtlSec: int(env, 'OPERATOR_CONFIRMATION_TTL_SEC', 8 * 3600, 60, 7 * 86_400),
    },
    // Defaults are deliberately conservative starting points, all overridable per deployment.
    rate: {
      login_ip: rule(env, 'LOGIN_IP', 60, 900),
      login_identifier: rule(env, 'LOGIN_IDENTIFIER', 10, 900),
      register_ip: rule(env, 'REGISTER_IP', 20, 3600),
      refresh_ip: rule(env, 'REFRESH_IP', 120, 900),
      owner_verify_owner: rule(env, 'OWNER_VERIFY_OWNER', 8, 300),
      owner_verify_ip: rule(env, 'OWNER_VERIFY_IP', 30, 300),
      step_up_owner: rule(env, 'STEP_UP_OWNER', 10, 300),
      step_up_ip: rule(env, 'STEP_UP_IP', 30, 300),
      factor_enroll_owner: rule(env, 'FACTOR_ENROLL_OWNER', 10, 3600),
      recovery_ip: rule(env, 'RECOVERY_IP', 10, 3600),
      recovery_identifier: rule(env, 'RECOVERY_IDENTIFIER', 5, 3600),
      operator_request_identifier: rule(env, 'OPERATOR_REQUEST_IDENTIFIER', 5, 3600),
      operator_request_ip: rule(env, 'OPERATOR_REQUEST_IP', 30, 3600),
      // Per-operator, independent of IP: an attacker rotating IPs still hits this one.
      operator_verify_identifier: rule(env, 'OPERATOR_VERIFY_IDENTIFIER', 10, 900),
      operator_verify_ip: rule(env, 'OPERATOR_VERIFY_IP', 40, 900),
      // Coarse global brake on distributed guessing across many operators.
      operator_verify_global: rule(env, 'OPERATOR_VERIFY_GLOBAL', 600, 60),
      operator_confirm_ip: rule(env, 'OPERATOR_CONFIRM_IP', 30, 900),
      // Join codes are onboarding credentials: resolution is throttled per IP and by a global brake so a
      // botnet cannot enumerate the code space, and every failure looks identical to the caller.
      join_code_resolve_ip: rule(env, 'JOIN_CODE_RESOLVE_IP', 20, 900),
      join_code_resolve_global: rule(env, 'JOIN_CODE_RESOLVE_GLOBAL', 1000, 60),
      join_code_manage_actor: rule(env, 'JOIN_CODE_MANAGE_ACTOR', 30, 3600),
      membership_op_actor: rule(env, 'MEMBERSHIP_OP_ACTOR', 120, 900),
      contact_request_user: rule(env, 'CONTACT_REQUEST_USER', 5, 3600),
      contact_verify_user: rule(env, 'CONTACT_VERIFY_USER', 10, 900),
      contact_verify_ip: rule(env, 'CONTACT_VERIFY_IP', 40, 900),
      // Admin invitations grant a privileged capability: resolution/acceptance are throttled harder than join codes.
      invitation_resolve_ip: rule(env, 'INVITATION_RESOLVE_IP', 15, 900),
      invitation_resolve_global: rule(env, 'INVITATION_RESOLVE_GLOBAL', 500, 60),
      invitation_accept_ip: rule(env, 'INVITATION_ACCEPT_IP', 10, 900),
      invitation_manage_actor: rule(env, 'INVITATION_MANAGE_ACTOR', 20, 3600),
    },
    payment: {
      baseUrl: env.PAYMENT_SERVICE_URL ?? '',
      serviceToken: payToken,
      timeoutMs: int(env, 'PAYMENT_TIMEOUT_MS', 3000, 100, 30_000),
    },
    onboarding: {
      requireContactVerification: env.REQUIRE_CONTACT_VERIFICATION === 'true',
      contactCodeTtlSec: int(env, 'CONTACT_CODE_TTL_SEC', 900, 60, 3600),
      invitation: invitation,
    },
    docs: { username: env.SWAGGER_USERNAME || 'docs', password: docsPassword },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

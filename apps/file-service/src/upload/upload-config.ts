import { ConfigError, type EnvReader } from '@nawara/service-kit';

export interface UploadConfig {
  /** `FILE_UPLOAD_TICKET_TTL_SECONDS` (default 120, 60–300, F16): an upload ticket's lifetime. It bounds the START of an upload only. */
  ticketTtlSeconds: number;
  /** `FILE_ATTACH_TTL_SECONDS` (default 24 h, F18): how long a new file stays temporary before its owner must attach it (cleanup: 17.7). */
  attachTtlSeconds: number;
  /** `FILE_UPLOAD_IDLE_TIMEOUT_MS` (default 30 s, SDD §15): an upload that sends no byte for this long is cut off. */
  idleTimeoutMs: number;
  /** `FILE_PUBLIC_BASE_URL`: where clients reach File Service; a ticket URL is `<base>/file/t/<token>`. HTTPS in production. */
  publicBaseUrl: string;
  /** `FILE_REQUEST_HASH_KEY` (base64, ≥ 32 bytes; F22): keys the service-upload request hash. Never stored, never logged. */
  requestHashKey: Buffer;
  /** `FILE_RATE_LIMIT_KEY` (base64, ≥ 32 bytes; F32): keys client addresses before they reach the rate-limit table. */
  rateLimitKey: Buffer;
  /** `FILE_TICKET_FAILURE_LIMIT` (default 20 per minute per client): failed ticket redemptions (upload and download) before a client is refused. */
  ticketFailureLimit: number;
  /** Stage 17.6: `FILE_DOWNLOAD_TICKET_TTL_SECONDS` (default 120, 60–300, F16): a download ticket's lifetime (reusable until then). */
  downloadTicketTtlSeconds: number;
  /** Stage 17.6: `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` (default 30 s): a download whose client accepts no byte for this long is cut off. */
  downloadIdleTimeoutMs: number;
}

function keyMaterial(reader: EnvReader, name: string): Buffer {
  const raw = reader.required(name);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new ConfigError(`${name} must be base64`);
  const key = Buffer.from(raw, 'base64');
  if (key.length < 32) throw new ConfigError(`${name} must decode to at least 32 bytes`);
  return key;
}

/** Stage 17.5 settings. Errors name the variable and never echo a value (keys may come from `*_FILE`). */
export function loadUploadConfig(reader: EnvReader, isProduction: boolean): UploadConfig {
  const publicBaseUrl = reader.url('FILE_PUBLIC_BASE_URL', isProduction ? ['https:'] : ['https:', 'http:']);
  const parsed = new URL(publicBaseUrl);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || publicBaseUrl.endsWith('/')) {
    throw new ConfigError('FILE_PUBLIC_BASE_URL must be a plain base URL without credentials, query, fragment or trailing slash');
  }
  const requestHashKey = keyMaterial(reader, 'FILE_REQUEST_HASH_KEY');
  const rateLimitKey = keyMaterial(reader, 'FILE_RATE_LIMIT_KEY');
  if (requestHashKey.equals(rateLimitKey)) throw new ConfigError('FILE_REQUEST_HASH_KEY and FILE_RATE_LIMIT_KEY must be different keys (one key, one purpose)');
  return {
    ticketTtlSeconds: reader.int('FILE_UPLOAD_TICKET_TTL_SECONDS', { default: 120, min: 60, max: 300 }),
    attachTtlSeconds: reader.int('FILE_ATTACH_TTL_SECONDS', { default: 86_400, min: 300, max: 2_592_000 }),
    idleTimeoutMs: reader.int('FILE_UPLOAD_IDLE_TIMEOUT_MS', { default: 30_000, min: 1_000, max: 120_000 }),
    publicBaseUrl,
    requestHashKey,
    rateLimitKey,
    ticketFailureLimit: reader.int('FILE_TICKET_FAILURE_LIMIT', { default: 20, min: 1, max: 1_000 }),
    downloadTicketTtlSeconds: reader.int('FILE_DOWNLOAD_TICKET_TTL_SECONDS', { default: 120, min: 60, max: 300 }),
    downloadIdleTimeoutMs: reader.int('FILE_DOWNLOAD_IDLE_TIMEOUT_MS', { default: 30_000, min: 1_000, max: 120_000 }),
  };
}

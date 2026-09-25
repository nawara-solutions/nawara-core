import { HttpException, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigError, DbService, RateLimitModule, RateLimitService, type EnvReader } from '@nawara/service-kit';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';

/** What a trusted caller spends (F32): service uploads, ticket issuance (upload and download tickets), service content reads. */
export type UsageKind = 'upload' | 'ticket' | 'download';
const KINDS: readonly UsageKind[] = ['upload', 'ticket', 'download'];

/** One fixed window for every usage limit; the retention task relies on it. */
export const USAGE_WINDOW_SECONDS = 60;

export interface UsageLimitsConfig {
  /** `FILE_<KIND>_RATE_PER_CALLER` / `_PER_ORGANIZATION`: requests per minute, per caller and per (caller, organization). */
  perCaller: Record<UsageKind, number>;
  perOrganization: Record<UsageKind, number>;
  /** `FILE_TICKET_MAX_DOWNLOADS` (default 50): redemptions of ONE reusable download ticket over its whole (≤ 300 s) lifetime. */
  ticketMaxDownloads: number;
  /** `FILE_UPLOAD_MAX_IN_FLIGHT` (default 64): uploads streaming at once in ONE process (threat model: bounded concurrency). */
  uploadMaxInFlight: number;
}

const DEFAULTS: Record<UsageKind, { caller: number; organization: number }> = {
  upload: { caller: 600, organization: 120 },
  ticket: { caller: 1_200, organization: 300 },
  download: { caller: 1_200, organization: 300 },
};

/** Stage 17.8 (F32). An organization budget above its caller's would never apply: refused at boot. */
export function loadUsageLimitsConfig(reader: EnvReader): UsageLimitsConfig {
  const perCaller = {} as Record<UsageKind, number>;
  const perOrganization = {} as Record<UsageKind, number>;
  for (const kind of KINDS) {
    const name = kind.toUpperCase();
    perCaller[kind] = reader.int(`FILE_${name}_RATE_PER_CALLER`, { default: DEFAULTS[kind].caller, min: 1, max: 1_000_000 });
    perOrganization[kind] = reader.int(`FILE_${name}_RATE_PER_ORGANIZATION`, { default: DEFAULTS[kind].organization, min: 1, max: 1_000_000 });
    if (perOrganization[kind] > perCaller[kind]) throw new ConfigError(`FILE_${name}_RATE_PER_ORGANIZATION must not exceed FILE_${name}_RATE_PER_CALLER`);
  }
  return {
    perCaller,
    perOrganization,
    ticketMaxDownloads: reader.int('FILE_TICKET_MAX_DOWNLOADS', { default: 50, min: 1, max: 10_000 }),
    uploadMaxInFlight: reader.int('FILE_UPLOAD_MAX_IN_FLIGHT', { default: 64, min: 1, max: 4_096 }),
  };
}

/** Every limiter bucket this service owns, all on the same one-minute window (retention deletes expired windows of these only). */
export const FILE_LIMITER_BUCKETS = [...KINDS.flatMap((k) => [`file_${k}_caller`, `file_${k}_org`]), 'file_ticket_failures'];

/**
 * Per-caller and per-organization usage limits (Stage 17.8; ADR-0048 F32; threat model §6: upload flooding, orphan storage abuse,
 * download amplification). Checked AFTER authorization (an unauthorized request spends nothing) and BEFORE any database or storage work.
 * Every attempt counts, refused ones included (the kit limiter's rule: no free probing). The organization budget is keyed by the caller
 * AND the organization: one tenant cannot exhaust its caller's budget for the others, and one caller cannot spend another's. Platform
 * files (no organization) are bounded by the caller budget. Keys are caller names and organization ids (hashed by the kit), never a
 * token or a client address.
 */
@Injectable()
export class UsageLimiter {
  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly limiter: RateLimitService,
    private readonly db: DbService,
  ) {}

  async admit(kind: UsageKind, caller: string, organizationId: string | null): Promise<void> {
    const limits = this.config.limits;
    const byCaller = await this.limiter.hit(`file_${kind}_caller`, caller, { limit: limits.perCaller[kind], windowSec: USAGE_WINDOW_SECONDS });
    const byOrganization = organizationId === null
      ? { allowed: true }
      : await this.limiter.hit(`file_${kind}_org`, `${caller}|${organizationId}`, { limit: limits.perOrganization[kind], windowSec: USAGE_WINDOW_SECONDS });
    if (!byCaller.allowed || !byOrganization.allowed) throw new HttpException({ message: 'Too many requests.', code: 'rate_limited' }, 429);
  }

  /**
   * Retention of the limiter state (the Notification 16.9 rule): a row whose window has ended carries nothing the next hit needs (the
   * hit resets it). Only this service's buckets, a bounded batch, `SKIP LOCKED` (a row being hit is left for the next pass). Keyed client
   * addresses (`file_ticket_failures`) thus live at most one window plus one cleanup interval.
   */
  async purgeExpiredWindows(limit: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `WITH doomed AS MATERIALIZED (
         SELECT bucket, key FROM kit_rate_limit
          WHERE bucket = ANY($1::text[]) AND "windowStart" <= now() - make_interval(secs => $2)
          LIMIT $3 FOR UPDATE SKIP LOCKED)
       DELETE FROM kit_rate_limit k USING doomed WHERE k.bucket = doomed.bucket AND k.key = doomed.key`,
      [FILE_LIMITER_BUCKETS, USAGE_WINDOW_SECONDS, limit],
    );
    return rowCount ?? 0;
  }
}

@Module({ imports: [RateLimitModule], providers: [UsageLimiter], exports: [UsageLimiter] })
export class UsageLimitsModule {}

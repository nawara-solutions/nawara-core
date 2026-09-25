import { createHash } from 'node:crypto';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '../db/db.service.js';

export interface RateLimitRule {
  /** Requests allowed inside one window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

const BUCKET = /^[a-z][a-z0-9_-]{0,62}$/;

/**
 * Shared (Postgres-backed, so correct across instances) fixed-window rate limiter. Generic infrastructure: the bucket
 * name, the identifier and the rule are all supplied by the caller — this module carries no business meaning.
 * The counter increments on every call to `hit`, whether or not it turns out to be over the limit, so a caller cannot
 * probe for free. Windows expire on their own; nobody is locked out permanently. Identifiers are hashed (sha256) before
 * being stored, keyed by bucket, so raw values (IPs, emails, tokens) never sit in the table.
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private key(bucket: string, identifier: string): string {
    return createHash('sha256').update(`${bucket}:${identifier}`).digest('hex');
  }

  /** Records one hit for `identifier` in `bucket` and reports whether the rule's limit is still respected. */
  async hit(bucket: string, identifier: string, rule: RateLimitRule, q: Queryable = this.db): Promise<RateLimitResult> {
    if (!BUCKET.test(bucket)) throw new Error(`invalid rate-limit bucket name: ${bucket}`);
    const { rows } = await q.query<{ count: number }>(
      `INSERT INTO kit_rate_limit(bucket, key, "windowStart", count) VALUES ($1, $2, now(), 1)
       ON CONFLICT (bucket, key) DO UPDATE SET
         count = CASE WHEN kit_rate_limit."windowStart" <= now() - make_interval(secs => $3) THEN 1 ELSE kit_rate_limit.count + 1 END,
         "windowStart" = CASE WHEN kit_rate_limit."windowStart" <= now() - make_interval(secs => $3) THEN now() ELSE kit_rate_limit."windowStart" END
       RETURNING count`,
      [bucket, this.key(bucket, identifier), rule.windowSec],
    );
    return { allowed: rows[0].count <= rule.limit, count: rows[0].count, limit: rule.limit };
  }

  /**
   * Reports the current window's count WITHOUT recording a hit (Stage 17.5). For limits that count only failures: a caller checks
   * `peek` before the attempt and `hit`s only when the attempt fails, so a blocked identifier is refused for every attempt alike
   * (a limiter that only refused failures would tell a blocked client which of its attempts would have succeeded).
   */
  async peek(bucket: string, identifier: string, rule: RateLimitRule, q: Queryable = this.db): Promise<RateLimitResult> {
    if (!BUCKET.test(bucket)) throw new Error(`invalid rate-limit bucket name: ${bucket}`);
    const { rows } = await q.query<{ count: number }>(
      `SELECT count FROM kit_rate_limit WHERE bucket = $1 AND key = $2 AND "windowStart" > now() - make_interval(secs => $3)`,
      [bucket, this.key(bucket, identifier), rule.windowSec],
    );
    const count = rows[0]?.count ?? 0;
    return { allowed: count < rule.limit, count, limit: rule.limit };
  }

  /** Same as `hit`, but throws a 429 (with the additive `code: 'rate_limited'`) when the limit is exceeded. */
  async assert(bucket: string, identifier: string, rule: RateLimitRule, q?: Queryable): Promise<void> {
    const result = await this.hit(bucket, identifier, rule, q);
    if (!result.allowed) throw new HttpException({ message: 'Too many requests.', code: 'rate_limited' }, 429);
  }

  /** Clears the counter for one identifier — for example after a successful operation that should not count against it. */
  async reset(bucket: string, identifier: string): Promise<void> {
    await this.db.query(`DELETE FROM kit_rate_limit WHERE bucket = $1 AND key = $2`, [bucket, this.key(bucket, identifier)]);
  }
}

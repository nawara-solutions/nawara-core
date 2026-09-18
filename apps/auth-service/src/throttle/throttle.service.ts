import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig, type RateBucket } from '../config/app-config.js';
import { hmacHex } from '../crypto/hmac.js';
import { DbService } from '../db/db.service.js';

/**
 * Shared (Postgres-backed, so correct across instances) fixed-window rate limiter.
 * - The counter is incremented BEFORE the guarded check runs, so failed and successful attempts
 *   both count and an attacker cannot probe for free.
 * - Keys are HMACs (no raw emails/phones/IPs at rest).
 * - Windows expire on their own: nobody is locked out permanently.
 * - Independent buckets on identifier AND ip AND (for operator codes) a global brake, so rotating
 *   IPs or spreading guesses across operators still meets a limit.
 */
@Injectable()
export class ThrottleService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private key(bucket: RateBucket, raw: string) {
    return hmacHex(this.cfg.secrets.throttlePepper, `throttle.${bucket}`, raw);
  }

  /** Records a hit; throws 429 when the bucket's limit for the current window is exceeded. */
  async hit(bucket: RateBucket, raw: string): Promise<void> {
    const rule = this.cfg.rate[bucket];
    const { rows } = await this.db.query<{ count: number }>(
      `INSERT INTO auth_throttle(bucket, key, "windowStart", count) VALUES ($1,$2,now(),1)
       ON CONFLICT (bucket, key) DO UPDATE SET
         count = CASE WHEN auth_throttle."windowStart" <= now() - make_interval(secs => $3) THEN 1 ELSE auth_throttle.count + 1 END,
         "windowStart" = CASE WHEN auth_throttle."windowStart" <= now() - make_interval(secs => $3) THEN now() ELSE auth_throttle."windowStart" END
       RETURNING count`,
      [bucket, this.key(bucket, raw), rule.windowSec],
    );
    if (rows[0].count > rule.limit) {
      throw new HttpException('Too many attempts. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** After a SUCCESS, clears the per-identifier counter so a legitimate user is not penalised. */
  async reset(bucket: RateBucket, raw: string): Promise<void> {
    await this.db.query(`DELETE FROM auth_throttle WHERE bucket=$1 AND key=$2`, [bucket, this.key(bucket, raw)]);
  }
}

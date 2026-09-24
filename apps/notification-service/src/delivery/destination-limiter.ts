import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RateLimitService } from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { DestinationLimitConfig, NotificationConfig } from '../config/notification-config.js';

export const DESTINATION_BUCKET = 'notif_dest';
const DOMAIN = 'nawara.notification.destination-limit.v1|';

/**
 * The limiter identity of a destination (Stage 16.9, D21):
 *
 *   hex( HMAC-SHA-256( NOTIFICATION_DESTINATION_LIMIT_KEY, "nawara.notification.destination-limit.v1|" + channel + "|" + destination ) )
 *
 * The destination is keyed EXACTLY as intake accepted and stored it: canonical E.164 for SMS; for email the address byte for byte
 * (no case folding, no `+tag` or dot stripping, no provider-specific aliasing), so two distinct destinations never share a bucket. The
 * kit then stores sha256("notif_dest:" + this value): without the dedicated key nobody holding the table can test a guessed phone or
 * address against it, unlike a plain SHA-256 of a 10^8-candidate phone space.
 */
export function destinationIdentity(key: Buffer, channel: string, destination: string): string {
  return createHmac('sha256', key).update(`${DOMAIN}${channel}|${destination}`, 'utf8').digest('hex');
}

/**
 * `notif_dest` (SDD §11.3, ADR-0046 §14): at most `limit` sends per channel + destination per fixed window, across every caller and
 * template, applied by the worker right before the provider call. The kit counter is one atomic `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING` per hit, so concurrent workers can never exceed it. During a key rotation the previous key's bucket is hit as well and
 * both must allow, so a rotation neither resets a destination's count nor opens a burst; after one window the previous key is removed.
 * A limiter failure throws: the delivery is not sent (fail closed) and its claim is recovered as `PENDING` by the lease (no attempt).
 */
@Injectable()
export class DestinationLimiter {
  private readonly config?: DestinationLimitConfig;

  constructor(
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(NOTIFICATION_CONFIG) config: NotificationConfig,
  ) {
    this.config = config.delivery.destinationLimit;
  }

  get configured(): boolean {
    return this.config !== undefined;
  }

  async allow(channel: string, destination: string): Promise<boolean> {
    if (!this.config) throw new Error('the destination limiter is not configured (NOTIFICATION_DESTINATION_LIMIT_KEY)');
    const rule = { limit: this.config.limit, windowSec: this.config.windowSec };
    const keys = this.config.previousKey ? [this.config.key, this.config.previousKey] : [this.config.key];
    let allowed = true;
    for (const key of keys) allowed = (await this.limits.hit(DESTINATION_BUCKET, destinationIdentity(key, channel, destination), rule)).allowed && allowed;
    return allowed;
  }
}

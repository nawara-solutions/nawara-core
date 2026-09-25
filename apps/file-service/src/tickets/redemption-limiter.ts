import { createHmac } from 'node:crypto';
import { HttpException, Inject, Injectable, Module } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimitModule, RateLimitService } from '@nawara/service-kit';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';

/** One stable answer for every unusable ticket, upload or download (SDD §11.1): never which check failed. */
export const TICKET_INVALID = () => new HttpException({ message: 'The link is not valid.', code: 'ticket_invalid' }, 404);

/** Failed ticket redemptions per client (keyed address), per minute (F32). Upload and download share one budget. */
const TICKET_FAILURE_BUCKET = 'file_ticket_failures';

/**
 * The ticket-redemption abuse bound (Stage 17.5, shared by the download route in 17.6). The client address (`req.ip`, honouring
 * TRUST_PROXY) is keyed with FILE_RATE_LIMIT_KEY before it reaches the limiter table (an unkeyed IPv4 digest is reversible). Only
 * failures count; once a client is over its budget EVERY redemption is refused, valid or not, so a blocked client cannot tell a valid
 * ticket from an invalid one. No ticket material ever reaches the limiter.
 */
@Injectable()
export class RedemptionLimiter {
  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly limiter: RateLimitService,
  ) {}

  /** Refuses a blocked client (429); returns the one way to report this redemption as invalid (counted, then `ticket_invalid`). */
  async admit(req: Request): Promise<{ invalid: () => Promise<HttpException> }> {
    const client = createHmac('sha256', this.config.upload.rateLimitKey).update(req.ip ?? req.socket.remoteAddress ?? 'unknown').digest('hex');
    const rule = { limit: this.config.upload.ticketFailureLimit, windowSec: 60 };
    if (!(await this.limiter.peek(TICKET_FAILURE_BUCKET, client, rule)).allowed) {
      throw new HttpException({ message: 'Too many requests.', code: 'rate_limited' }, 429);
    }
    return {
      invalid: async () => {
        await this.limiter.hit(TICKET_FAILURE_BUCKET, client, rule);
        return TICKET_INVALID();
      },
    };
  }
}

@Module({ imports: [RateLimitModule], providers: [RedemptionLimiter], exports: [RedemptionLimiter] })
export class RedemptionModule {}

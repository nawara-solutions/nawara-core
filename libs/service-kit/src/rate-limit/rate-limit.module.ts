import { Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service.js';

/** Provides `RateLimitService`. Requires `DbModule` to already be imported (the limiter is Postgres-backed). */
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}

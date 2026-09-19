import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AttemptResolver, AttemptResolverService } from './attempt-resolver.js';
import { AttemptService } from './attempt.service.js';
import { AttemptsController } from './attempts.controller.js';

@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [AttemptsController],
  providers: [AttemptService, IdempotencyService, AttemptResolver, AttemptResolverService],
  exports: [AttemptResolver],
})
export class AttemptsModule {}

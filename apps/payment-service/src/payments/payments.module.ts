import { Module } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { PaymentAudit } from '../audit/payment-audit.js';
import { ExpirySweeper, ExpirySweeperService } from './expiry-sweeper.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentService } from './payment.service.js';

@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [PaymentsController],
  providers: [PaymentService, AuthorizationService, IdempotencyService, ExpirySweeper, ExpirySweeperService, PaymentAudit],
  exports: [PaymentService, AuthorizationService, ExpirySweeper, PaymentAudit],
})
export class PaymentsModule {}

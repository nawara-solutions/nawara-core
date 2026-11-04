import { Module } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { PaymentAudit } from '../audit/payment-audit.js';
import { ExpirySweeper, ExpirySweeperService } from './expiry-sweeper.js';
import { CaptureReconciler, CaptureReconcilerService } from './capture-reconciler.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentService } from './payment.service.js';

@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [PaymentsController],
  providers: [PaymentService, AuthorizationService, IdempotencyService, ExpirySweeper, ExpirySweeperService, CaptureReconciler, CaptureReconcilerService, PaymentAudit],
  exports: [PaymentService, AuthorizationService, ExpirySweeper, CaptureReconciler, PaymentAudit],
})
export class PaymentsModule {}

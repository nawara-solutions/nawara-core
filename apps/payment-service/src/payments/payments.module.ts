import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentService } from './payment.service.js';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController],
  providers: [PaymentService, AuthorizationService],
  exports: [PaymentService, AuthorizationService],
})
export class PaymentsModule {}

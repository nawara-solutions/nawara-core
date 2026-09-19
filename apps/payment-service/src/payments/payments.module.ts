import { Module } from '@nestjs/common';
import { ServiceOrUserGuard } from '../auth/service-or-user.guard.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentService } from './payment.service.js';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentService, AuthorizationService, ServiceOrUserGuard],
})
export class PaymentsModule {}

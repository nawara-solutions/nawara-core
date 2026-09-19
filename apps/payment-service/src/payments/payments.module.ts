import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ExpirySweeper, ExpirySweeperService } from './expiry-sweeper.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentService } from './payment.service.js';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController],
  providers: [PaymentService, AuthorizationService, ExpirySweeper, ExpirySweeperService],
  exports: [PaymentService, AuthorizationService, ExpirySweeper],
})
export class PaymentsModule {}

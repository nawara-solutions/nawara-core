import { Module } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import { AuthModule } from '../auth/auth.module.js';
import { InvoiceRepository } from './invoice.repository.js';
import { InvoicesController } from './invoices.controller.js';
import { PaymentRequestRepository } from './payment-request.repository.js';
import { PaymentRequestsController } from './payment-requests.controller.js';

/** Persistence and the HTTP API for the invoice aggregate and its payment requests (SDD 18.1, endpoints 7-14). */
@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [InvoicesController, PaymentRequestsController],
  providers: [InvoiceRepository, PaymentRequestRepository],
  exports: [InvoiceRepository, PaymentRequestRepository],
})
export class InvoicesModule {}

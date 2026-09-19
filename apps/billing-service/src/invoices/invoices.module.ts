import { Module } from '@nestjs/common';
import { InvoiceRepository } from './invoice.repository.js';
import { PaymentRequestRepository } from './payment-request.repository.js';

/** Persistence for the invoice aggregate and its payment requests. No controllers yet: the HTTP API is Stage 3. */
@Module({
  providers: [InvoiceRepository, PaymentRequestRepository],
  exports: [InvoiceRepository, PaymentRequestRepository],
})
export class InvoicesModule {}

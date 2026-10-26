import { Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module.js';
import { WebhookRetriever, WebhookRetrierService } from './webhook-retrier.js';
import { WebhookService } from './webhook.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [AttemptsModule],
  controllers: [WebhooksController],
  providers: [WebhookService, WebhookRetriever, WebhookRetrierService],
  exports: [WebhookService], // Core V2 S4f: the simulation harness delivers its notifications through the same pipeline
})
export class WebhooksModule {}

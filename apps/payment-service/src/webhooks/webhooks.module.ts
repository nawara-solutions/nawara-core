import { Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module.js';
import { WebhookRetriever, WebhookRetrierService } from './webhook-retrier.js';
import { WebhookService } from './webhook.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [AttemptsModule],
  controllers: [WebhooksController],
  providers: [WebhookService, WebhookRetriever, WebhookRetrierService],
})
export class WebhooksModule {}

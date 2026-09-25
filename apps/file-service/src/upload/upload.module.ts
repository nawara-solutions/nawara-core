import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RateLimitModule } from '@nawara/service-kit';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { UploadController } from './upload.controller.js';
import { uploadRouteHeaders } from './upload-http.js';
import { UploadService } from './upload.service.js';

/** The upload lifecycle (Stage 17.5): ticket issuance, ticket redemption, service upload, attach. */
@Module({
  imports: [PersistenceModule, RateLimitModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(uploadRouteHeaders).forRoutes(
      { path: 'file/files', method: RequestMethod.POST },
      { path: 'file/t/*token', method: RequestMethod.PUT },
      { path: 'file/uploads/tickets', method: RequestMethod.POST },
    );
  }
}

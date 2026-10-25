import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DownloadModule, refuseHead } from '../download/download.module.js';
import { UsageLimitsModule } from '../limits/usage-limiter.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { GrantController } from './grant.controller.js';
import { GrantService } from './grant.service.js';
import { GrantedReadController } from './granted-read.controller.js';
import { GrantedReadService } from './granted-read.service.js';

/** Grant answers (errors included) are never cached: they carry access decisions. */
function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

/** Core V2 S2-File.1: evidence-grant issuance and revocation (owner services); S2-File.2: granted reads and tickets (grantees). */
@Module({
  imports: [PersistenceModule, DownloadModule, UsageLimitsModule],
  controllers: [GrantController, GrantedReadController],
  providers: [GrantService, GrantedReadService],
})
export class GrantModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // HEAD would run the GET handler: authorize and record an access just to send headers. Refused, as on the owner byte routes.
    consumer.apply(refuseHead).forRoutes(
      { path: 'file/evidence-grants/:grantId/files/:fileId', method: RequestMethod.HEAD },
      { path: 'file/evidence-grants/:grantId/files/:fileId/content', method: RequestMethod.HEAD },
    );
    consumer.apply(noStore).forRoutes(GrantController, GrantedReadController);
  }
}

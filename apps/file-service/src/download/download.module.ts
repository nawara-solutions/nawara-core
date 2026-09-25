import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { UsageLimitsModule } from '../limits/usage-limiter.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { RedemptionModule } from '../tickets/redemption-limiter.js';
import { DownloadController } from './download.controller.js';
import { DownloadService } from './download.service.js';

/** Download and ticket-management answers (errors included) are never cached: they carry capabilities or file metadata. */
function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

/**
 * HEAD is NOT supported on byte routes (Stage 17.6 decision). Express would silently answer HEAD with the GET handler, which would run
 * a redemption (and consume a single-use ticket) just to send headers: refused explicitly instead.
 */
function refuseHead(_req: Request, res: Response): void {
  res.setHeader('Allow', 'GET');
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(405).end();
}

/** The byte-read boundary (Stage 17.6): owner reads, download tickets (issue, redeem), ticket revocation. */
@Module({
  imports: [PersistenceModule, RedemptionModule, UsageLimitsModule],
  controllers: [DownloadController],
  providers: [DownloadService],
})
export class DownloadModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(refuseHead).forRoutes({ path: 'file/t/*token', method: RequestMethod.HEAD }, { path: 'file/files/:id/content', method: RequestMethod.HEAD });
    consumer.apply(noStore).forRoutes(
      { path: 'file/t/*token', method: RequestMethod.GET },
      { path: 'file/files/:id', method: RequestMethod.GET },
      { path: 'file/files/:id/content', method: RequestMethod.GET },
      { path: 'file/files/:id/tickets', method: RequestMethod.POST },
      { path: 'file/tickets/:ticketId', method: RequestMethod.DELETE },
    );
  }
}

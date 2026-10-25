import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { GrantController } from './grant.controller.js';
import { GrantService } from './grant.service.js';

/** Grant answers (errors included) are never cached: they carry access decisions. */
function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

/** Core V2 S2-File.1: evidence-grant issuance and revocation (owner services). */
@Module({
  imports: [PersistenceModule],
  controllers: [GrantController],
  providers: [GrantService],
})
export class GrantModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(noStore).forRoutes(GrantController);
  }
}

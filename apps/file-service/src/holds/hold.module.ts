import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { HoldController } from './hold.controller.js';
import { HoldService } from './hold.service.js';

/** Hold answers (errors included) are never cached. */
function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

/** Core V2 S2-File.3: evidence-hold placement and release (owner services). */
@Module({
  imports: [PersistenceModule],
  controllers: [HoldController],
  providers: [HoldService],
})
export class HoldModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(noStore).forRoutes(HoldController);
  }
}

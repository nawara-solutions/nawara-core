import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { SimulationController } from './simulation.controller.js';
import { SimulationService } from './simulation.service.js';

/** Core V2 S4f (PAY-14, F-S5): imported only when the simulation provider is enabled outside production (`app.module.ts`). */
@Module({
  imports: [WebhooksModule],
  controllers: [SimulationController],
  providers: [SimulationService],
})
export class SimulationModule {}

import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { ReleasePolicyGuard } from '../policy/release-policy.guard.js';
import { AutomationController } from './automation.controller.js';
import { AutomationService } from './automation.service.js';

/** Stage 20.3: the CI automation API (registration and publication). The audit module and the configuration are global. */
@Module({ imports: [PersistenceModule], controllers: [AutomationController], providers: [AutomationService, ReleasePolicyGuard] })
export class AutomationModule {}

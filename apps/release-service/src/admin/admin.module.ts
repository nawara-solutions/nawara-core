import { Module, type DynamicModule } from '@nestjs/common';
import type { ReleaseConfig } from '../config/release-config.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY } from './owner-authority.client.js';
import { OwnerGuard } from './owner.guard.js';

/**
 * Stage 20.4: owner administration. Mounted ONLY when `AUTH_SERVICE_URL` and `RELEASE_OPERATING_COMPANY_ID` are configured; otherwise the
 * routes do not exist (nobody can withdraw a release or change a policy). The audit module and the configuration are global.
 */
@Module({})
export class AdminModule {
  static register(config: ReleaseConfig): DynamicModule {
    if (!config.ownerAdmin) return { module: AdminModule };
    return {
      module: AdminModule,
      imports: [PersistenceModule],
      controllers: [AdminController],
      providers: [AdminService, OwnerGuard, { provide: OWNER_AUTHORITY, useValue: new HttpOwnerAuthority({ baseUrl: config.ownerAdmin.authServiceUrl }) }],
    };
  }
}

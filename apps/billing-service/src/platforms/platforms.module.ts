import { Module, type DynamicModule } from '@nestjs/common';
import type { BillingConfig } from '../config/billing-config.js';
import { BillingPlatformRepository } from './billing-platform.repository.js';
import { BillingPlatformsController } from './billing-platforms.controller.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from './owner-authority.client.js';
import { PlatformOwnerGuard } from './owner.guard.js';
import { FeeActorGuard } from '../fees/fee-actor.guard.js';
import { FeeCommandIdempotency } from '../fees/fee-idempotency.js';
import { FeeRepository } from '../fees/fee.repository.js';
import { FeeService } from '../fees/fee.service.js';
import { FeeAdminController, FeeProposalsController } from '../fees/fees.controller.js';

/** Core V2 S3d (register BIL-01): the Platform commercial configuration and its Owner check against the configured Auth; S3f (BIL-04 to BIL-07): fee caps, delegations and proposals. */
@Module({})
export class PlatformsModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority): DynamicModule {
    return {
      module: PlatformsModule,
      controllers: [BillingPlatformsController, FeeAdminController, FeeProposalsController], // S3f: fees share the live Owner / operator Auth port
      providers: [
        BillingPlatformRepository,
        PlatformOwnerGuard,
        FeeActorGuard, FeeCommandIdempotency, FeeRepository, FeeService,
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
      ],
    };
  }
}

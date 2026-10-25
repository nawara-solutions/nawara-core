import { Module, type DynamicModule } from '@nestjs/common';
import type { BillingConfig } from '../config/billing-config.js';
import { BillingPlatformRepository } from './billing-platform.repository.js';
import { BillingPlatformsController } from './billing-platforms.controller.js';
import { HttpOwnerAuthority, OWNER_AUTHORITY, type OwnerAuthority } from './owner-authority.client.js';
import { PlatformOwnerGuard } from './owner.guard.js';

/** Core V2 S3d (register BIL-01): the Platform commercial configuration and its Owner check against the configured Auth. */
@Module({})
export class PlatformsModule {
  static register(config: BillingConfig, ownerAuthority?: OwnerAuthority): DynamicModule {
    return {
      module: PlatformsModule,
      controllers: [BillingPlatformsController],
      providers: [
        BillingPlatformRepository,
        PlatformOwnerGuard,
        { provide: OWNER_AUTHORITY, useValue: ownerAuthority ?? new HttpOwnerAuthority({ baseUrl: config.authServiceUrl }) },
      ],
    };
  }
}

import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module.js';
import type { OrganizationConfig } from '../config/organization-config.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { PlatformsModule } from '../platforms/platforms.module.js';
import { AdminController } from './admin.controller.js';
import { ActorRecordService } from './actor-record.service.js';
import { HttpAuthGrantsClient, type AuthGrantsClient } from './auth-grants-client.js';
import { AUTH_GRANTS_CLIENT, HumanAuthGuard } from './human-auth.guard.js';

/**
 * The ONE module in this service that authenticates a human bearer and calls Auth (ADR-0042 decision 6,
 * Amendment 1). boundary.spec.ts carves out an explicit exception for `admin/`, exactly as it already
 * does for `ownership/` — the Stage-9 "no Auth dependency, no user-token handling" rule still holds
 * everywhere else in this service.
 */
@Module({})
export class AdminModule {
  /** `authGrantsClient` is a TEST FIXTURE ONLY override; production always builds the real HTTP client from config. */
  static forRoot(config: OrganizationConfig, authGrantsClient?: AuthGrantsClient) {
    return {
      module: AdminModule,
      imports: [PlatformsModule, OrganizationsModule, CompaniesModule],
      controllers: [AdminController],
      providers: [
        ActorRecordService,
        HumanAuthGuard,
        { provide: AUTH_GRANTS_CLIENT, useValue: authGrantsClient ?? (new HttpAuthGrantsClient({ baseUrl: config.authServiceUrl, timeoutMs: config.authTimeoutMs }) as AuthGrantsClient) },
      ],
    };
  }
}

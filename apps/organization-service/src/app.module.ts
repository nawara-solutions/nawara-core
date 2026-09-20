import { fileURLToPath } from 'node:url';
import { Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, ServiceAuthModule, kitMigrationsDir } from '@nawara/service-kit';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { ServicePolicy } from './authorization/service-policy.js';
import { CompaniesModule } from './companies/companies.module.js';
import type { OrganizationConfig } from './config/organization-config.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { OwnershipModule } from './ownership/ownership.module.js';
import { PlatformsModule } from './platforms/platforms.module.js';
import { ReferenceModule } from './reference/reference.module.js';

/** The service's own migrations, applied by the explicit `npm run migrate` step and never at startup. */
export const organizationMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export interface AppModuleOverrides {
  /** Tests point readiness at the migrations they applied. */
  migrationsDirs?: string[];
  /** TEST FIXTURES ONLY: a ready-made policy. Production always builds it from SERVICE_POLICY (fail closed). */
  servicePolicy?: ServicePolicy;
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never pass against a
 * differently wired application than the one that ships.
 *
 * What is deliberately ABSENT: no Auth client (this service never calls Auth, and never sees a user's bearer), no events module
 * (no organization events until a concrete consumer needs them), no outbound HTTP client of any kind.
 */
@Module({})
export class AppModule {
  static register(config: OrganizationConfig, overrides: AppModuleOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        HealthModule.forRoot(),
        DbModule.forRoot({
          url: config.databaseUrl,
          applicationName: config.serviceName,
          migrations: { dirs: overrides.migrationsDirs ?? [kitMigrationsDir, organizationMigrationsDir] },
        }),
        ServiceAuthModule.forRoot(config.serviceTokens),
        AuthorizationModule.forRoot(overrides.servicePolicy ?? ServicePolicy.parse(config.servicePolicyRaw, config.serviceTokens.map((t) => t.caller))),
        IdempotencyModule,
        OwnershipModule,
        CompaniesModule,
        PlatformsModule,
        OrganizationsModule,
        ReferenceModule,
      ],
    };
  }
}

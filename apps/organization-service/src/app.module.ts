import { fileURLToPath } from 'node:url';
import { Module, type DynamicModule } from '@nestjs/common';
import { DbModule, HealthModule, ServiceAuthModule, kitMigrationsDir } from '@nawara/service-kit';
import { AdminModule } from './admin/admin.module.js';
import type { AuthGrantsClient } from './admin/auth-grants-client.js';
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
  /** TEST FIXTURES ONLY: replaces the real HTTP call to Auth's grant-facts/step-up-verify endpoints. */
  authGrantsClient?: AuthGrantsClient;
}

/**
 * The whole module graph. `main.ts` and the test suites build it through the SAME function, so a test can never pass against a
 * differently wired application than the one that ships.
 *
 * What is deliberately ABSENT everywhere except `admin/` (ADR-0042 decision 6, Amendment 1): no events module (no organization
 * events until a concrete consumer needs them), no outbound HTTP client of any other kind, no user-token handling. `admin/` is
 * the one bounded exception, exactly as `ownership/` already is for the migration/authority machinery (boundary.spec.ts carves
 * out both, and nothing else).
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
          // Stage 14.4: bounded pool wait/connect, statement and idle-in-transaction limits (validated in the kit's base config).
          max: config.db.poolMax,
          connectionTimeoutMs: config.db.connectionTimeoutMs,
          statementTimeoutMs: config.db.statementTimeoutMs,
          idleInTransactionTimeoutMs: config.db.idleInTransactionTimeoutMs,
          queryTimeoutMs: config.db.queryTimeoutMs, // Stage 15.2 (I9): client-side deadline for a silent server
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
        AdminModule.forRoot(config, overrides.authGrantsClient),
      ],
    };
  }
}

import { Global, Module, type DynamicModule } from '@nestjs/common';
import {
  ORGANIZATION_REFERENCE, SERVICE_OPERATION_POLICY, ServiceOperationGuard, buildOrganizationReference, operationsPolicy,
  type OrganizationReferenceResolver,
} from '@nawara/service-kit';
import type { BillingConfig } from '../config/billing-config.js';
import { OrganizationScopeService } from './organization-scope.service.js';

/** Stage 21.C.2: Billing's caller admission (the operation policy and the Organization reference). `reference` is for tests only. */
@Global()
@Module({})
export class CallerAdmissionModule {
  static forRoot(config: BillingConfig, reference?: OrganizationReferenceResolver): DynamicModule {
    return {
      module: CallerAdmissionModule,
      providers: [
        { provide: SERVICE_OPERATION_POLICY, useValue: operationsPolicy(config.servicePolicy) },
        { provide: ORGANIZATION_REFERENCE, useValue: reference ?? buildOrganizationReference(config.organizationReference, config.isProduction) },
        ServiceOperationGuard,
        OrganizationScopeService,
      ],
      exports: [SERVICE_OPERATION_POLICY, ORGANIZATION_REFERENCE, ServiceOperationGuard, OrganizationScopeService],
    };
  }
}

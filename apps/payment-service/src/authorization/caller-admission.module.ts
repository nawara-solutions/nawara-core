import { Global, Module, type DynamicModule } from '@nestjs/common';
import {
  ORGANIZATION_REFERENCE, SERVICE_OPERATION_POLICY, ServiceOperationGuard, buildOrganizationReference, operationsPolicy,
  type OrganizationReferenceResolver,
} from '@nawara/service-kit';
import type { PaymentConfig } from '../config/payment-config.js';
import { OrganizationScopeService } from './organization-scope.service.js';

/**
 * Stage 21.C.2: Payment's caller admission. The operation policy (read by the kit `ServiceOperationGuard`) and the Organization reference
 * (the configured source behind the positive memo). `reference` replaces the source in tests only.
 */
@Global()
@Module({})
export class CallerAdmissionModule {
  static forRoot(config: PaymentConfig, reference?: OrganizationReferenceResolver): DynamicModule {
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

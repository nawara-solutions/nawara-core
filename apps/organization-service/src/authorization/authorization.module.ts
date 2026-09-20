import { Global, Module, type DynamicModule } from '@nestjs/common';
import { PlatformScopeService } from './platform-scope.service.js';
import { ServicePolicyGuard } from './service-policy.guard.js';
import { SERVICE_POLICY, type ServicePolicy } from './service-policy.js';

@Global()
@Module({})
export class AuthorizationModule {
  static forRoot(policy: ServicePolicy): DynamicModule {
    return {
      module: AuthorizationModule,
      providers: [{ provide: SERVICE_POLICY, useValue: policy }, ServicePolicyGuard, PlatformScopeService],
      exports: [SERVICE_POLICY, ServicePolicyGuard, PlatformScopeService],
    };
  }
}

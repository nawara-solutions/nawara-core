import { DynamicModule, Global, Module } from '@nestjs/common';
import { SERVICE_TOKENS, ServiceTokenGuard } from './service-token.guard.js';
import type { ServiceTokenEntry } from './service-token.js';

/** Global: `ServiceTokenGuard` is a singleton auth mechanism every feature module needs, not per-module state. */
@Global()
@Module({})
export class ServiceAuthModule {
  static forRoot(tokens: ServiceTokenEntry[]): DynamicModule {
    return {
      module: ServiceAuthModule,
      providers: [{ provide: SERVICE_TOKENS, useValue: tokens }, ServiceTokenGuard],
      exports: [ServiceTokenGuard, SERVICE_TOKENS],
    };
  }
}

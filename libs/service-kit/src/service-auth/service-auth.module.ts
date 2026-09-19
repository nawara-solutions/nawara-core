import { DynamicModule, Module } from '@nestjs/common';
import { SERVICE_TOKENS, ServiceTokenGuard } from './service-token.guard.js';
import type { ServiceTokenEntry } from './service-token.js';

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

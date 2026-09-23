import { DynamicModule, Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ReadinessRegistry } from './readiness.registry.js';
import { ShutdownNotice } from './shutdown-notice.js';

@Global()
@Module({})
export class HealthModule {
  static forRoot(opts: { checkTimeoutMs?: number } = {}): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: ReadinessRegistry, useFactory: () => new ReadinessRegistry(opts.checkTimeoutMs) }, ShutdownNotice],
      exports: [ReadinessRegistry],
    };
  }
}

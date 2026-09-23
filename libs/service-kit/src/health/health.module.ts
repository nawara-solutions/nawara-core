import { DynamicModule, Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { DEFAULT_HTTP_DRAIN_TIMEOUT_MS, HTTP_DRAIN_OPTIONS, HttpDrain, ShutdownState } from './http-drain.js';
import { ReadinessRegistry } from './readiness.registry.js';
import { ShutdownNotice } from './shutdown-notice.js';

@Global()
@Module({})
export class HealthModule {
  /** `httpDrainTimeoutMs`: the service's `HTTP_DRAIN_TIMEOUT_MS` (Stage 15.5), the bound on the HTTP drain once shutdown starts. */
  static forRoot(opts: { checkTimeoutMs?: number; httpDrainTimeoutMs?: number } = {}): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        ShutdownState,
        { provide: HTTP_DRAIN_OPTIONS, useValue: { drainTimeoutMs: opts.httpDrainTimeoutMs ?? DEFAULT_HTTP_DRAIN_TIMEOUT_MS } },
        { provide: ReadinessRegistry, useFactory: (state: ShutdownState) => new ReadinessRegistry(opts.checkTimeoutMs, undefined, () => state.draining), inject: [ShutdownState] },
        ShutdownNotice,
        HttpDrain,
      ],
      exports: [ReadinessRegistry, ShutdownState],
    };
  }
}

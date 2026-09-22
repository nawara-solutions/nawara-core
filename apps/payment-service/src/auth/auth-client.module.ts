import { DynamicModule, Global, Module } from '@nestjs/common';
import { AUTH_CLIENT, HttpAuthClient, type AuthClient } from '@nawara/service-kit';

/** Global: every feature module needs AUTH_CLIENT (the combined service-or-user guard, in particular), not per-module state. */
@Global()
@Module({})
export class AuthClientModule {
  static forRoot(opts: { baseUrl: string; timeoutMs?: number }): DynamicModule {
    return {
      module: AuthClientModule,
      providers: [{ provide: AUTH_CLIENT, useValue: new HttpAuthClient(opts) satisfies AuthClient }],
      exports: [AUTH_CLIENT],
    };
  }
}

import { DynamicModule, Global, Module } from '@nestjs/common';
import { HttpAuthClient, type AuthClient } from '@nawara/service-kit';
import { AUTH_CLIENT } from './auth-client.token.js';

/** Global: every feature module needs AUTH_CLIENT (the combined service-or-user guard in particular), not per-module state. */
@Global()
@Module({})
export class AuthClientModule {
  static forRoot(client: AuthClient | { baseUrl: string; timeoutMs?: number }): DynamicModule {
    const useValue = 'getIdentity' in client ? client : new HttpAuthClient(client);
    return {
      module: AuthClientModule,
      providers: [{ provide: AUTH_CLIENT, useValue }],
      exports: [AUTH_CLIENT],
    };
  }
}

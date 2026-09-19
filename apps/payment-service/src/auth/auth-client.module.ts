import { DynamicModule, Module } from '@nestjs/common';
import { HttpAuthClient, type AuthClient } from '@nawara/service-kit';
import { AUTH_CLIENT } from './auth-client.token.js';

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

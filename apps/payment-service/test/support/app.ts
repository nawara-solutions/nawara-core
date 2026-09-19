import { Controller, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import {
  DbModule, EventsModule, HealthModule, InMemoryEventBus, JsonLogger, RateLimitModule, ReadinessRegistry, ServiceAuthModule,
  configureApp, kitMigrationsDir, type AuthClient, type ServiceTokenEntry,
} from '@nawara/service-kit';
import { AUTH_CLIENT } from '../../src/auth/auth-client.token.js';
import { ServiceOrUserGuard } from '../../src/auth/service-or-user.guard.js';
import { loadPaymentConfig, type PaymentConfig } from '../../src/config/payment-config.js';
import { PAYMENT_CONFIG } from '../../src/config/payment-config.token.js';

export interface TestApp {
  app: NestExpressApplication;
  config: PaymentConfig;
  registry: ReadinessRegistry;
  logs: Record<string, unknown>[];
}

const noopAuthClient: AuthClient = {
  getIdentity: async () => null,
  hasPlatformAccess: async () => false,
};

/** Proves `rawBody: true` (main.ts) actually captures the exact bytes, ahead of the webhook feature that needs them. */
@Controller('probe')
class RawBodyProbeController {
  @Post('raw-body')
  echo(@Req() req: RawBodyRequest<Request>) {
    return { rawBodyBase64: req.rawBody ? req.rawBody.toString('base64') : null, parsedBody: req.body };
  }
}

/** Builds a real Nest app wired the same way `AppModule` is, but with test-controlled config/DB/Auth — no network calls. */
export async function createTestApp(opts: {
  databaseUrl: string;
  tokens?: ServiceTokenEntry[];
  authClient?: AuthClient;
  env?: NodeJS.ProcessEnv;
  migrationsDirs?: string[];
}): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const config = loadPaymentConfig({
    NODE_ENV: 'test',
    DATABASE_URL: opts.databaseUrl,
    AUTH_SERVICE_URL: 'http://auth.invalid',
    ...opts.env,
  });
  const logger = new JsonLogger(config.serviceName, 'error', (l) => logs.push(JSON.parse(l)));

  const moduleRef = await Test.createTestingModule({
    imports: [
      HealthModule.forRoot({ checkTimeoutMs: 1500 }),
      DbModule.forRoot({ url: opts.databaseUrl, migrations: { dirs: opts.migrationsDirs ?? [kitMigrationsDir] } }),
      ServiceAuthModule.forRoot(opts.tokens ?? []),
      EventsModule.forRoot({ source: 'payment-service', bus: new InMemoryEventBus() }),
      RateLimitModule,
    ],
    controllers: [RawBodyProbeController],
    providers: [
      { provide: PAYMENT_CONFIG, useValue: config },
      { provide: AUTH_CLIENT, useValue: opts.authClient ?? noopAuthClient },
      ServiceOrUserGuard,
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true, logger: false });
  configureApp(app, config, logger);
  await app.listen(0, '127.0.0.1');
  return { app, config, registry: app.get(ReadinessRegistry), logs };
}

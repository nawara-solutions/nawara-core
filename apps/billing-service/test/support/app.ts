import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  InMemoryEventBus, JsonLogger, ReadinessRegistry, configureApp, kitMigrationsDir, type AuthClient, type ServiceTokenEntry,
} from '@nawara/service-kit';
import { AppModule, billingMigrationsDir } from '../../src/app.module.js';
import { loadBillingConfig, type BillingConfig } from '../../src/config/billing-config.js';
import { mountDocs } from '../../src/docs/mount-docs.js';
import { ProbeModule } from './probe.js';

export interface TestApp {
  app: NestExpressApplication;
  config: BillingConfig;
  registry: ReadinessRegistry;
  /** Every structured log line the application wrote, at DEBUG level. */
  logs: Record<string, unknown>[];
}

const noopAuthClient: AuthClient = {
  getIdentity: async () => null,
  hasPlatformAccess: async () => false,
};

/**
 * Builds the REAL application module (`AppModule.register`, the same function `main.ts` uses) plus the test-only probe routes,
 * wired exactly as `main.ts` wires the HTTP baseline (`configureApp`, docs). Only what a test must control is replaced: the Auth
 * client (no network) and the event bus (in memory).
 */
export async function createTestApp(opts: {
  databaseUrl: string;
  tokens?: ServiceTokenEntry[];
  authClient?: AuthClient;
  env?: NodeJS.ProcessEnv;
  migrationsDirs?: string[];
}): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const config = loadBillingConfig({
    NODE_ENV: 'test',
    DATABASE_URL: opts.databaseUrl,
    AUTH_SERVICE_URL: 'http://auth.invalid',
    BILLING_SUPPORTED_CURRENCIES: 'TND',
    ...(opts.tokens?.length ? { SERVICE_TOKENS: opts.tokens.map((t) => `${t.caller}:${t.digest}`).join(',') } : {}),
    ...opts.env,
  });
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => logs.push(JSON.parse(l)));

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register(config, {
        authClient: opts.authClient ?? noopAuthClient,
        bus: new InMemoryEventBus(),
        migrationsDirs: opts.migrationsDirs ?? [kitMigrationsDir, billingMigrationsDir],
      }),
      ProbeModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, config, logger);
  mountDocs(app, config);
  await app.listen(0, '127.0.0.1');
  return { app, config, registry: app.get(ReadinessRegistry), logs };
}

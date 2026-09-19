import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  EVENT_BUS, InMemoryEventBus, JsonLogger, ReadinessRegistry, configureApp, kitMigrationsDir, type AuthClient, type ServiceTokenEntry,
} from '@nawara/service-kit';
import { AppModule, billingMigrationsDir } from '../../src/app.module.js';
import { loadBillingConfig, type BillingConfig } from '../../src/config/billing-config.js';
import { mountDocs } from '../../src/docs/mount-docs.js';
import { PAYMENT_CLIENT } from '../../src/payment-integration/payment-client.token.js';
import type { PaymentClient } from '../../src/payment-integration/payment-client.js';
import { ProbeModule } from './probe.js';

export interface TestApp {
  app: NestExpressApplication;
  config: BillingConfig;
  registry: ReadinessRegistry;
  /** Every structured log line the application wrote, at DEBUG level. */
  logs: Record<string, unknown>[];
  /** Typed as the concrete in-memory bus (tests only ever run against it) so a test can inspect `.published`/`.deadLettered`. */
  bus: InMemoryEventBus;
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
  /** A test double for the Payment client (SDD 21.2 port): no network, full control over dispatch/reconcile outcomes. Defaults to the real HTTP client against an invalid host (used only by tests that never call it). */
  paymentClient?: PaymentClient;
  env?: NodeJS.ProcessEnv;
  migrationsDirs?: string[];
}): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const config = loadBillingConfig({
    NODE_ENV: 'test',
    DATABASE_URL: opts.databaseUrl,
    AUTH_SERVICE_URL: 'http://auth.invalid',
    BILLING_SUPPORTED_CURRENCIES: 'TND',
    PAYMENT_SERVICE_URL: 'http://payment.invalid',
    PAYMENT_SERVICE_TOKEN: 'test-only-payment-service-token-not-a-real-secret-000',
    // Long by default so the auto-started dispatcher/reconciler never race an assertion mid-test; tests that exercise
    // them call `dispatchOnce()`/`reconcileOnce()` directly (the same pattern Payment's own AttemptResolver tests use).
    // `BILLING_DISPATCH_INTERVAL_MS` is capped at 300_000 (dispatch's own configured max); `BILLING_RECONCILE_INTERVAL_MS`
    // allows up to an hour, so it is set further out.
    BILLING_DISPATCH_INTERVAL_MS: '300000',
    BILLING_RECONCILE_INTERVAL_MS: '3600000',
    ...(opts.tokens?.length ? { SERVICE_TOKENS: opts.tokens.map((t) => `${t.caller}:${t.digest}`).join(',') } : {}),
    ...opts.env,
  });
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => logs.push(JSON.parse(l)));
  const bus = new InMemoryEventBus();

  let builder = Test.createTestingModule({
    imports: [
      AppModule.register(config, {
        authClient: opts.authClient ?? noopAuthClient,
        bus,
        migrationsDirs: opts.migrationsDirs ?? [kitMigrationsDir, billingMigrationsDir],
      }),
      ProbeModule,
    ],
  });
  if (opts.paymentClient) builder = builder.overrideProvider(PAYMENT_CLIENT).useValue(opts.paymentClient);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, config, logger);
  mountDocs(app, config);
  await app.listen(0, '127.0.0.1');
  return { app, config, registry: app.get(ReadinessRegistry), logs, bus: app.get<InMemoryEventBus>(EVENT_BUS) };
}

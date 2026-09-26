import { Controller, Global, Module, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import {
  AUTH_CLIENT, DbModule, EventsModule, HealthModule, InMemoryEventBus, JsonLogger, RateLimitModule, ReadinessRegistry, ServiceAuthModule,
  configureApp, kitMigrationsDir, type AuthClient, type OrganizationReferenceResolver, type ServiceTokenEntry,
} from '@nawara/service-kit';
import { AttemptsModule } from '../../src/attempts/attempts.module.js';
import { CallerAdmissionModule } from '../../src/authorization/caller-admission.module.js';
import { loadPaymentConfig, type PaymentConfig } from '../../src/config/payment-config.js';
import { PaymentConfigModule } from '../../src/config/payment-config.module.js';
import { PaymentsModule } from '../../src/payments/payments.module.js';
import { ProvidersModule } from '../../src/providers/providers.module.js';
import { WebhooksModule } from '../../src/webhooks/webhooks.module.js';

/** The Platform every Organization resolves to under the default test reference (a test double, never production code). */
export const TEST_PLATFORM = 'aaaaaaaa-0000-4000-8000-00000000a11f';
export const TEST_COMPANY = 'aaaaaaaa-0000-4000-8000-00000000c0de';
/** Default test reference: any uuid is an Organization of TEST_PLATFORM. Suites that test verification pass their own. */
export const anyOrganizationReference: OrganizationReferenceResolver = {
  resolve: async (organizationId) => ({ organizationId: organizationId.toLowerCase(), platformId: TEST_PLATFORM, companyId: TEST_COMPANY }),
};
/**
 * Stage 21.C.2: the pre-enforcement suites exercise producers' OBJECT rules (their own payments, another producer's), so by default every
 * test caller holds every Payment operation within TEST_PLATFORM. The admission suite passes its own `PAYMENT_SERVICE_POLICY`.
 */
export function allOperationsPolicy(tokens: ServiceTokenEntry[]): string {
  const callers = [...new Set(tokens.map((t) => t.caller))];
  return JSON.stringify({ callers: Object.fromEntries(callers.map((c) => [c, { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [TEST_PLATFORM] }])) });
}

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

/** Global, like `AuthClientModule` in production, so feature modules (PaymentsModule) can inject AUTH_CLIENT. */
@Global()
@Module({})
class TestAuthClientModule {
  static forRoot(authClient: AuthClient) {
    return { module: TestAuthClientModule, providers: [{ provide: AUTH_CLIENT, useValue: authClient }], exports: [AUTH_CLIENT] };
  }
}

/** Builds a real Nest app wired the same way `AppModule` is, but with test-controlled config/DB/Auth — no network calls. */
export async function createTestApp(opts: {
  databaseUrl: string;
  tokens?: ServiceTokenEntry[];
  authClient?: AuthClient;
  env?: NodeJS.ProcessEnv;
  migrationsDirs?: string[];
  /** Replaces the Organization reference source (default: `anyOrganizationReference`). */
  reference?: OrganizationReferenceResolver;
}): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const config = loadPaymentConfig({
    NODE_ENV: 'test',
    DATABASE_URL: opts.databaseUrl,
    AUTH_SERVICE_URL: 'http://auth.invalid',
    SERVICE_TOKENS: (opts.tokens ?? []).map((t) => `${t.caller}:${t.digest}`).join(','),
    PAYMENT_SERVICE_POLICY: allOperationsPolicy(opts.tokens ?? []),
    ...opts.env,
  });
  const logger = new JsonLogger(config.serviceName, 'error', (l) => logs.push(JSON.parse(l)));

  const moduleRef = await Test.createTestingModule({
    imports: [
      HealthModule.forRoot({ checkTimeoutMs: 1500 }),
      DbModule.forRoot({ url: opts.databaseUrl, migrations: { dirs: opts.migrationsDirs ?? [kitMigrationsDir] } }),
      ServiceAuthModule.forRoot(opts.tokens ?? []),
      TestAuthClientModule.forRoot(opts.authClient ?? noopAuthClient),
      PaymentConfigModule.forRoot(config),
      CallerAdmissionModule.forRoot(config, opts.reference ?? anyOrganizationReference),
      EventsModule.forRoot({ source: 'payment-service', bus: new InMemoryEventBus() }),
      RateLimitModule,
      ProvidersModule,
      PaymentsModule,
      AttemptsModule,
      WebhooksModule,
    ],
    controllers: [RawBodyProbeController],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true, logger: false });
  configureApp(app, config, logger);
  await app.listen(0, '127.0.0.1');
  return { app, config, registry: app.get(ReadinessRegistry), logs };
}

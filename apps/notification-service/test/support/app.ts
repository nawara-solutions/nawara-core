import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { InMemoryEventBus, JsonLogger, ReadinessRegistry, configureApp, type EventBus, type ServiceTokenEntry } from '@nawara/service-kit';
import { AppModule } from '../../src/app.module.js';
import { loadNotificationConfig, type NotificationConfig } from '../../src/config/notification-config.js';
import type { ProviderRegistry } from '../../src/delivery/provider.js';
import { mountDocs } from '../../src/docs/mount-docs.js';
import { EventConsumer } from '../../src/intake/event-consumer.js';
import { IntakeService } from '../../src/intake/intake.service.js';
import { ProbeModule } from './probe.js';

export interface TestApp {
  app: NestExpressApplication;
  config: NotificationConfig;
  registry: ReadinessRegistry;
  intake: IntakeService;
  consumer: EventConsumer;
  /** The in-memory bus when one was used (the default), else undefined. */
  bus?: InMemoryEventBus;
  /** Every structured log line the application wrote, at DEBUG level. */
  logs: Record<string, unknown>[];
}

/** A database nothing listens on: for suites that exercise only the HTTP foundation (readiness then answers 503, liveness 200). */
export const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';
/** A broker nothing listens on (the `rabbitmq` readiness check then fails). */
export const UNREACHABLE_RABBITMQ_URL = 'amqp://nobody:nothing@127.0.0.1:1';
/** A fixed test key ring (never a real secret). */
export const TEST_SECRET_KEYS = `t1:${randomBytes(32).toString('base64')}`;
/** The test request-hash key (never a real secret). */
export const TEST_REQUEST_HASH_KEY = randomBytes(32);
/** The test destination-limiter key (Stage 16.9; never a real secret). */
export const TEST_DESTINATION_LIMIT_KEY = randomBytes(32);
/** Every published template, for a test caller's default policy. */
export const ALL_TEMPLATES = [
  'identity.contact_verification_code', 'identity.operator_confirmation_code', 'identity.operator_login_code', 'identity.owner_new_device_login',
  'identity.owner_recovery_completed', 'identity.owner_recovery_requested', 'membership.approved', 'membership.rejected', 'membership.revoked',
];
/** The default policy of test callers: every template, both channels, organizations allowed (a fixture; production policies are explicit). */
export const openPolicy = (callers: string[]) =>
  JSON.stringify({ callers: Object.fromEntries(callers.map((c) => [c, { templates: ALL_TEMPLATES, channels: ['EMAIL', 'SMS'], organizations: 'request' }])) });

/**
 * Builds the REAL application module (`AppModule.register`, the same function `main.ts` uses) plus the test-only probe routes, wired
 * exactly as `main.ts` wires the HTTP baseline. The event bus is the kit's in-memory bus unless `bus: 'rabbitmq'` asks for the real one
 * (then `RABBITMQ_URL` must reach a broker) or a bus is passed.
 */
export async function createTestApp(
  opts: {
    databaseUrl?: string; rabbitmqUrl?: string; tokens?: ServiceTokenEntry[]; env?: NodeJS.ProcessEnv; probes?: boolean; migrationsDirs?: string[];
    bus?: EventBus | 'rabbitmq';
    /** The raw NOTIFICATION_SERVICE_POLICY; defaults to `openPolicy` for the registered test callers. */
    policy?: string;
    /** Stage 16.7: providers injected in place of the configured ones (fakes with controlled outcomes). */
    providers?: ProviderRegistry;
  } = {},
): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const config = loadNotificationConfig({
    NODE_ENV: 'test',
    DATABASE_URL: opts.databaseUrl ?? UNREACHABLE_DATABASE_URL,
    RABBITMQ_URL: opts.rabbitmqUrl ?? process.env.TEST_RABBITMQ_URL ?? UNREACHABLE_RABBITMQ_URL,
    NOTIFICATION_SECRET_KEYS: TEST_SECRET_KEYS,
    NOTIFICATION_SECRET_ACTIVE_KEY_ID: 't1',
    NOTIFICATION_DEFAULT_LOCALE: 'en',
    NOTIFICATION_REQUEST_HASH_KEY: TEST_REQUEST_HASH_KEY.toString('base64'),
    NOTIFICATION_DESTINATION_LIMIT_KEY: TEST_DESTINATION_LIMIT_KEY.toString('base64'),
    ...(opts.tokens?.length
      ? { SERVICE_TOKENS: opts.tokens.map((t) => `${t.caller}:${t.digest}`).join(','), NOTIFICATION_SERVICE_POLICY: opts.policy ?? openPolicy([...new Set(opts.tokens.map((t) => t.caller))]) }
      : {}),
    ...opts.env,
  });
  const bus = opts.bus === 'rabbitmq' ? undefined : (opts.bus ?? new InMemoryEventBus());
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => logs.push(JSON.parse(l)));
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config, { migrationsDirs: opts.migrationsDirs, bus, providers: opts.providers }), ...(opts.probes === false ? [] : [ProbeModule])],
  })
    .setLogger(logger)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app, config, logger);
  mountDocs(app, config); // as main.ts does, before the application starts (only when SWAGGER_PASSWORD is set)
  await app.init();
  return {
    app, config, logs, registry: app.get(ReadinessRegistry), intake: app.get(IntakeService), consumer: app.get(EventConsumer),
    bus: bus instanceof InMemoryEventBus ? bus : undefined,
  };
}

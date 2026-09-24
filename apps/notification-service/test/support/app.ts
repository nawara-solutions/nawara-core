import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { InMemoryEventBus, JsonLogger, ReadinessRegistry, configureApp, type EventBus, type ServiceTokenEntry } from '@nawara/service-kit';
import { AppModule } from '../../src/app.module.js';
import { loadNotificationConfig, type NotificationConfig } from '../../src/config/notification-config.js';
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

/**
 * Builds the REAL application module (`AppModule.register`, the same function `main.ts` uses) plus the test-only probe routes, wired
 * exactly as `main.ts` wires the HTTP baseline. The event bus is the kit's in-memory bus unless `bus: 'rabbitmq'` asks for the real one
 * (then `RABBITMQ_URL` must reach a broker) or a bus is passed.
 */
export async function createTestApp(
  opts: { databaseUrl?: string; rabbitmqUrl?: string; tokens?: ServiceTokenEntry[]; env?: NodeJS.ProcessEnv; probes?: boolean; migrationsDirs?: string[]; bus?: EventBus | 'rabbitmq' } = {},
): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const config = loadNotificationConfig({
    NODE_ENV: 'test',
    DATABASE_URL: opts.databaseUrl ?? UNREACHABLE_DATABASE_URL,
    RABBITMQ_URL: opts.rabbitmqUrl ?? process.env.TEST_RABBITMQ_URL ?? UNREACHABLE_RABBITMQ_URL,
    NOTIFICATION_SECRET_KEYS: TEST_SECRET_KEYS,
    NOTIFICATION_SECRET_ACTIVE_KEY_ID: 't1',
    NOTIFICATION_DEFAULT_LOCALE: 'en',
    ...(opts.tokens?.length ? { SERVICE_TOKENS: opts.tokens.map((t) => `${t.caller}:${t.digest}`).join(',') } : {}),
    ...opts.env,
  });
  const bus = opts.bus === 'rabbitmq' ? undefined : (opts.bus ?? new InMemoryEventBus());
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => logs.push(JSON.parse(l)));
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config, { migrationsDirs: opts.migrationsDirs, bus }), ...(opts.probes === false ? [] : [ProbeModule])],
  })
    .setLogger(logger)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app, config, logger);
  await app.init();
  return {
    app, config, logs, registry: app.get(ReadinessRegistry), intake: app.get(IntakeService), consumer: app.get(EventConsumer),
    bus: bus instanceof InMemoryEventBus ? bus : undefined,
  };
}

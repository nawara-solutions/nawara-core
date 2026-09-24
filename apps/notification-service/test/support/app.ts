import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, ReadinessRegistry, configureApp, type ServiceTokenEntry } from '@nawara/service-kit';
import { AppModule } from '../../src/app.module.js';
import { loadNotificationConfig, type NotificationConfig } from '../../src/config/notification-config.js';
import { ProbeModule } from './probe.js';

export interface TestApp {
  app: NestExpressApplication;
  config: NotificationConfig;
  registry: ReadinessRegistry;
  /** Every structured log line the application wrote, at DEBUG level. */
  logs: Record<string, unknown>[];
}

/**
 * Builds the REAL application module (`AppModule.register`, the same function `main.ts` uses) plus the test-only probe routes,
 * wired exactly as `main.ts` wires the HTTP baseline (`configureApp`). Nothing of the application is replaced: the foundation has
 * no outbound dependency to stub.
 */
export async function createTestApp(opts: { tokens?: ServiceTokenEntry[]; env?: NodeJS.ProcessEnv; probes?: boolean } = {}): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const config = loadNotificationConfig({
    NODE_ENV: 'test',
    ...(opts.tokens?.length ? { SERVICE_TOKENS: opts.tokens.map((t) => `${t.caller}:${t.digest}`).join(',') } : {}),
    ...opts.env,
  });
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => logs.push(JSON.parse(l)));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config), ...(opts.probes === false ? [] : [ProbeModule])] })
    .setLogger(logger)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app, config, logger);
  await app.init();
  return { app, config, registry: app.get(ReadinessRegistry), logs };
}

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, ReadinessRegistry, configureApp, type EventBus } from '@nawara/service-kit';
import { AppModule } from '../../src/app.module.js';
import { loadReleaseConfig, type ReleaseConfig } from '../../src/config/release-config.js';
import { mountDocs } from '../../src/docs/mount-docs.js';
import { configureHttpServer } from '../../src/http/http-server.js';

export interface TestApp {
  app: NestExpressApplication;
  config: ReleaseConfig;
  registry: ReadinessRegistry;
  /** Every structured log line the application wrote, at DEBUG level. */
  logs: Record<string, unknown>[];
}

/** A database nothing listens on: for suites that exercise only the HTTP foundation (readiness then answers 503, liveness 200). */
export const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';

/** Builds the REAL application module (`AppModule.register`, the same function `main.ts` uses), wired as `main.ts` wires it. */
export async function createTestApp(opts: { databaseUrl?: string; env?: NodeJS.ProcessEnv; migrationsDirs?: string[]; bus?: EventBus } = {}): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const config = loadReleaseConfig({ NODE_ENV: 'test', DATABASE_URL: opts.databaseUrl ?? UNREACHABLE_DATABASE_URL, ...opts.env });
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => logs.push(JSON.parse(l) as Record<string, unknown>));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config, { migrationsDirs: opts.migrationsDirs, bus: opts.bus })] })
    .setLogger(logger)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app, config, logger);
  app.set('etag', false); // as main.ts (Stage 20.5)
  mountDocs(app, config); // only when SWAGGER_PASSWORD is set, as in main.ts
  configureHttpServer(app.getHttpServer(), config);
  await app.init();
  return { app, config, logs, registry: app.get(ReadinessRegistry) };
}

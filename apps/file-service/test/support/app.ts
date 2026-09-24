import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JsonLogger, ReadinessRegistry, configureApp, type ServiceTokenEntry } from '@nawara/service-kit';
import { AppModule } from '../../src/app.module.js';
import { loadFileConfig, type FileConfig } from '../../src/config/file-config.js';
import { ProbeModule } from './probe.js';

export interface TestApp {
  app: NestExpressApplication;
  config: FileConfig;
  registry: ReadinessRegistry;
  /** Every structured log line the application wrote, at DEBUG level. */
  logs: Record<string, unknown>[];
}

/**
 * Every structured log line written by ANY test application in this process. Nest's static `Logger` follows the application created
 * LAST, so a line logged through it can land in another application's buffer: log-leak assertions scan this, not one app's `logs`.
 */
export const ALL_LOGS: Record<string, unknown>[] = [];

/** A database nothing listens on: for suites that exercise only the HTTP foundation (readiness then answers 503, liveness 200). */
export const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';

/** The default policy of test callers: read only, platform files (a fixture; production policies are explicit). */
export const readOnlyPolicy = (callers: string[]) => JSON.stringify({ callers: Object.fromEntries(callers.map((c) => [c, { operations: ['read'], organizations: 'none' }])) });

/**
 * Builds the REAL application module (`AppModule.register`, the same function `main.ts` uses) plus the test-only probe routes, wired
 * exactly as `main.ts` wires the HTTP baseline.
 */
export async function createTestApp(
  opts: { databaseUrl?: string; tokens?: ServiceTokenEntry[]; env?: NodeJS.ProcessEnv; probes?: boolean; migrationsDirs?: string[]; policy?: string } = {},
): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const config = loadFileConfig({
    NODE_ENV: 'test',
    DATABASE_URL: opts.databaseUrl ?? UNREACHABLE_DATABASE_URL,
    ...(opts.tokens?.length
      ? { SERVICE_TOKENS: opts.tokens.map((t) => `${t.caller}:${t.digest}`).join(','), FILE_SERVICE_POLICY: opts.policy ?? readOnlyPolicy([...new Set(opts.tokens.map((t) => t.caller))]) }
      : {}),
    ...opts.env,
  });
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => {
    const line = JSON.parse(l) as Record<string, unknown>;
    logs.push(line);
    ALL_LOGS.push(line);
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config, { migrationsDirs: opts.migrationsDirs }), ...(opts.probes === false ? [] : [ProbeModule])],
  })
    .setLogger(logger)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app, config, logger);
  await app.init();
  return { app, config, logs, registry: app.get(ReadinessRegistry) };
}

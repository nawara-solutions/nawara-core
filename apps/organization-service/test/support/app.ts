import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { JsonLogger, ReadinessRegistry, configureApp, generateServiceToken, kitMigrationsDir, type ServiceTokenEntry } from '@nawara/service-kit';
import { AppModule, organizationMigrationsDir } from '../../src/app.module.js';
import { loadOrganizationConfig, type OrganizationConfig } from '../../src/config/organization-config.js';
import { mountDocs } from '../../src/docs/mount-docs.js';

export interface TestApp {
  app: NestExpressApplication;
  config: OrganizationConfig;
  registry: ReadinessRegistry;
  /** Every structured log line the application wrote, at DEBUG level. */
  logs: Record<string, unknown>[];
  /** Registered callers: name -> raw bearer token. */
  callers: Record<string, string>;
  /** Supertest agent bound to the running app. */
  http: () => ReturnType<typeof request>;
}

/** Generates a raw token + digest for each named caller (only the digest goes to the service, as in production). */
export function makeCallers(...names: string[]): { entries: ServiceTokenEntry[]; tokens: Record<string, string> } {
  const entries: ServiceTokenEntry[] = [];
  const tokens: Record<string, string> = {};
  for (const name of names) {
    const { token, digest } = generateServiceToken();
    entries.push({ caller: name, digest });
    tokens[name] = token;
  }
  return { entries, tokens };
}

/**
 * Builds the REAL application module (`AppModule.register`, the same function `main.ts` uses), wired exactly as `main.ts` wires the
 * HTTP baseline (`configureApp`, docs). Nothing of the application is replaced: this service has no outbound dependency to stub.
 */
export async function createTestApp(opts: {
  databaseUrl: string;
  callers?: string[];
  env?: NodeJS.ProcessEnv;
  migrationsDirs?: string[];
}): Promise<TestApp> {
  const logs: Record<string, unknown>[] = [];
  const { entries, tokens } = makeCallers(...(opts.callers ?? ['billing-service', 'payment-service']));
  const config = loadOrganizationConfig({
    NODE_ENV: 'test',
    DATABASE_URL: opts.databaseUrl,
    SERVICE_TOKENS: entries.map((t) => `${t.caller}:${t.digest}`).join(','),
    ...opts.env,
  });
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => logs.push(JSON.parse(l)));
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config, { migrationsDirs: opts.migrationsDirs ?? [kitMigrationsDir, organizationMigrationsDir] })],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, config, logger);
  mountDocs(app, config);
  await app.listen(0, '127.0.0.1');
  return { app, config, registry: app.get(ReadinessRegistry), logs, callers: tokens, http: () => request(app.getHttpServer()) };
}

/** A key that satisfies the Idempotency-Key shape and is unique per call. */
export const newKey = (): string => `k-${randomUUID()}`;

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

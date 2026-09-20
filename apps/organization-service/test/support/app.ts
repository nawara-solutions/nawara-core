import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import { JsonLogger, ReadinessRegistry, configureApp, generateServiceToken, kitMigrationsDir, type ServiceTokenEntry } from '@nawara/service-kit';
import type { AuthGrantsClient } from '../../src/admin/auth-grants-client.js';
import { AppModule, organizationMigrationsDir } from '../../src/app.module.js';
import { ServicePolicy } from '../../src/authorization/service-policy.js';
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
/**
 * Walks the ownership state to ACTIVE the legal way (each step passes the database's transition guard), as the schema owner. Existing
 * suites that create hierarchy data through the API run against an authoritative service; the ownership suites opt out with
 * `ownership: 'inactive'`. A database without the ownership table (a partial migration set) is left alone.
 */
export async function activateOwnership(databaseUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const t = await c.query(`SELECT to_regclass('public.ownership_state') AS t`);
    if (!t.rows[0].t) return;
    const { rows } = await c.query('SELECT phase FROM ownership_state');
    if (rows[0].phase === 'ACTIVE' || rows[0].phase === 'RETIRED') return;
    await c.query(`UPDATE ownership_state SET environment_class = COALESCE(environment_class, 'fresh')`);
    if (rows[0].phase === 'PREPARED') await c.query(`UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = 'test'`);
    const cls = (await c.query('SELECT environment_class FROM ownership_state')).rows[0].environment_class;
    const phase = (await c.query('SELECT phase FROM ownership_state')).rows[0].phase;
    if (phase === 'VERIFIED' && cls === 'existing') await c.query(`UPDATE ownership_state SET phase = 'FROZEN'`);
    await c.query(`UPDATE ownership_state SET phase = 'ACTIVATABLE', approved_by = 'test', approved_reference = 'test', approved_at = now()`);
    await c.query(`UPDATE ownership_state SET phase = 'ACTIVE', activated_by = 'test', activated_at = now()`);
  } finally {
    await c.end();
  }
}

export async function createTestApp(opts: {
  databaseUrl: string;
  /** 'authoritative' (default) activates ownership first; 'inactive' leaves the database exactly as the migrations made it. */
  ownership?: 'authoritative' | 'inactive';
  /**
   * The RAW `SERVICE_POLICY` JSON, parsed by the real parser against the registered callers. When omitted the suite gets the
   * unrestricted TEST FIXTURE (the behavior before ADR-0042; production refuses it).
   */
  policy?: string;
  callers?: string[];
  env?: NodeJS.ProcessEnv;
  migrationsDirs?: string[];
  /** TEST FIXTURE ONLY: replaces the real HTTP call to Auth's grant-facts/step-up-verify endpoints (admin/ module). */
  authGrantsClient?: AuthGrantsClient;
}): Promise<TestApp> {
  if ((opts.ownership ?? 'authoritative') === 'authoritative') await activateOwnership(opts.databaseUrl);
  const logs: Record<string, unknown>[] = [];
  const { entries, tokens } = makeCallers(...(opts.callers ?? ['billing-service', 'payment-service']));
  const callerNames = opts.callers ?? ['billing-service', 'payment-service'];
  const servicePolicy = opts.policy !== undefined ? ServicePolicy.parse(opts.policy, callerNames) : ServicePolicy.testFixture(callerNames, false);
  const config = loadOrganizationConfig({
    NODE_ENV: 'test',
    DATABASE_URL: opts.databaseUrl,
    SERVICE_TOKENS: entries.map((t) => `${t.caller}:${t.digest}`).join(','),
    AUTH_SERVICE_URL: 'http://127.0.0.1:1', // unreachable by construction: only the admin-module suites exercise this, and they override it
    ...opts.env,
  });
  const logger = new JsonLogger(config.serviceName, 'debug', (l) => logs.push(JSON.parse(l)));
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config, { migrationsDirs: opts.migrationsDirs ?? [kitMigrationsDir, organizationMigrationsDir], servicePolicy, authGrantsClient: opts.authGrantsClient })],
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

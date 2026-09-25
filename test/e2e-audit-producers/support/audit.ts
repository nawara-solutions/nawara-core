import { fileURLToPath } from 'node:url';
import amqp from 'amqplib';
import pg from 'pg';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { spawnService, waitFor, waitForHealth, type LiveService } from './process.js';

export const APPS = fileURLToPath(new URL('../../../apps/', import.meta.url));
export const AUDIT_DIR = `${APPS}audit-service`;
export const AUDIT_QUEUES = ['audit-service.audit', 'audit-service.audit.retry', 'audit-service.audit.dead'];
const ALL = ['security', 'business', 'commercial', 'administrative'];

export interface LiveAudit {
  db: TestDatabase;
  url: string;
  service: LiveService;
  orgReader: { token: string };
  platformReader: { token: string };
  /** Restarts the process on the same database (the service down then up). */
  stop(): Promise<void>;
  start(): Promise<void>;
  records(where: string, params?: unknown[]): Promise<Array<Record<string, any>>>;
  get(path: string, token: string): Promise<{ status: number; body: any }>;
}

/** Runs one statement on its own connection. */
export async function sql<T = Record<string, any>>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Deletes the audit queues (a throwaway / dev broker only): no message of a previous run leaks into this one. */
export async function resetAuditQueues(rabbitmqUrl: string): Promise<void> {
  const conn = await amqp.connect(rabbitmqUrl);
  try {
    for (const q of AUDIT_QUEUES) {
      const ch = await conn.createChannel();
      ch.on('error', () => undefined);
      await ch.deleteQueue(q).catch(() => undefined);
      await ch.close().catch(() => undefined);
    }
  } finally {
    await conn.close().catch(() => undefined);
  }
}

export async function deadDepth(rabbitmqUrl: string): Promise<number> {
  const conn = await amqp.connect(rabbitmqUrl);
  try {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    return (await ch.checkQueue('audit-service.audit.dead')).messageCount;
  } catch {
    return 0;
  } finally {
    await conn.close().catch(() => undefined);
  }
}

/**
 * A live audit-service from its built dist (never imported), on its own database, consuming the real broker, with two query callers:
 * an organization reader and a platform reader (every category).
 */
export async function startAudit(adminUrl: string, rabbitmqUrl: string, port: number): Promise<LiveAudit> {
  const db = await createTestDatabase(adminUrl, 'e2eaudit');
  await runMigrations(db.url, [kitMigrationsDir, `${AUDIT_DIR}/db/migrations/`]);
  const org = generateServiceToken();
  const platform = generateServiceToken();
  const url = `http://127.0.0.1:${port}`;
  const env = {
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: db.url,
    RABBITMQ_URL: rabbitmqUrl,
    SERVICE_TOKENS: `org-reader:${org.digest},platform-reader:${platform.digest}`,
    AUDIT_SERVICE_POLICY: JSON.stringify({ callers: { 'org-reader': { operations: ['read_organization'], categories: ALL }, 'platform-reader': { operations: ['read_platform'], categories: ALL } } }),
  };
  const live: LiveAudit = {
    db, url, service: spawnService('audit', AUDIT_DIR, env),
    orgReader: { token: org.token }, platformReader: { token: platform.token },
    async stop() {
      await live.service.stop();
    },
    async start() {
      live.service = spawnService('audit', AUDIT_DIR, env);
      await ready(url, live.service);
    },
    records: (where, params = []) => sql(db.url, `SELECT * FROM audit_record WHERE ${where} ORDER BY id`, params),
    async get(path, token) {
      const r = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: r.status, body: await r.json() };
    },
  };
  await ready(url, live.service);
  return live;
}

async function ready(url: string, service: LiveService): Promise<void> {
  try {
    await waitForHealth(`${url}/health`, 30_000);
    await waitFor(async () => (await fetch(`${url}/ready`)).status === 200, 30_000, 'audit-service /ready');
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- audit ---\n${service.tail()}`);
  }
}

/** Every key of an audit payload that could carry prohibited data, searched in the serialized outbox payload. */
export const PROHIBITED = [/password/i, /token/i, /secret/i, /\botp\b/i, /email/i, /phone/i, /address/i, /\bip\b/i, /user.?agent/i, /storage.?key/i, /ticket/i, /credential/i, /cookie/i, /authorization/i];

import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { RabbitMqEventBus, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 21.C.2 (ADR-0052 decision 4, C3): the loss window Auth's outbox closes, proved on live processes, a real broker and real databases:
 *
 *   Auth HTTP request -> COMMIT (change + outbox row)   broker unreachable: nothing leaves
 *        -> auth-service KILLED (SIGKILL: no shutdown hook, no drain)
 *        -> broker back, auth-service restarted on the same database
 *        -> the relay publishes the committed row -> notification-service intake -> ONE notification for that event id
 *   and a duplicate delivery of the same event id is absorbed by Notification's (sourceService, sourceEventId) identity.
 *
 * Before 21.C.2 this event was lost (fire-and-forget, in-memory, not retried). Each service runs from its built `dist/main.js`.
 * Prerequisite: `npm run build -w @nawara/service-kit -w auth-service -w notification-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const NOTIFICATION_DIR = `${ROOT}apps/notification-service`;
const AUTH_PORT = 13221;
const NOTIFICATION_PORT = 13222;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const NOTIFICATION_URL = `http://127.0.0.1:${NOTIFICATION_PORT}`;
const QUEUE = 'notification.events';
const rand = () => randomBytes(32).toString('base64');
const RATE_BUCKETS = [
  'LOGIN_IP', 'LOGIN_IDENTIFIER', 'REGISTER_IP', 'REFRESH_IP', 'OWNER_VERIFY_OWNER', 'OWNER_VERIFY_IP', 'STEP_UP_OWNER', 'STEP_UP_IP',
  'FACTOR_ENROLL_OWNER', 'RECOVERY_IP', 'RECOVERY_IDENTIFIER', 'OPERATOR_REQUEST_IDENTIFIER', 'OPERATOR_REQUEST_IP', 'OPERATOR_VERIFY_IDENTIFIER',
  'OPERATOR_VERIFY_IP', 'OPERATOR_VERIFY_GLOBAL', 'OPERATOR_CONFIRM_IP',
  'JOIN_CODE_RESOLVE_IP', 'JOIN_CODE_RESOLVE_GLOBAL', 'JOIN_CODE_MANAGE_ACTOR', 'MEMBERSHIP_OP_ACTOR', 'MEMBERSHIP_JOIN_USER', 'CONTACT_REQUEST_USER', 'CONTACT_VERIFY_USER', 'CONTACT_VERIFY_IP',
  'INVITATION_RESOLVE_IP', 'INVITATION_RESOLVE_GLOBAL', 'INVITATION_ACCEPT_IP', 'INVITATION_MANAGE_ACTOR',
];

async function sql<R extends pg.QueryResultRow = any>(url: string, text: string, params: unknown[] = []): Promise<R[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<R>(text, params)).rows;
  } finally {
    await c.end();
  }
}

describeWithEnv('Stage 21.C.2: Auth outbox durability across a crash, live processes', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let authDb: TestDatabase;
  let notificationDb: TestDatabase;
  let auth: LiveService;
  let notification: LiveService;
  let proxy: BrokerProxy;
  let conn: ChannelModel;
  const companyId = randomUUID();
  let authEnv: NodeJS.ProcessEnv;
  const crashed: { rowId?: string; userId?: string; payload?: Record<string, unknown> } = {};

  const deleteQueues = async () => {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    for (const q of [QUEUE, `${QUEUE}.retry`, `${QUEUE}.dead`]) await ch.deleteQueue(q).catch(() => undefined);
    await ch.close().catch(() => undefined);
  };
  async function operator(email: string): Promise<string> {
    const c = new pg.Client({ connectionString: authDb.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`INSERT INTO "user"(kind, email, role) VALUES ('operator', $1, 'admin') RETURNING id`, [email]);
      await c.query(`INSERT INTO operator("userId","companyId","contactVerifiedAt") VALUES ($1, $2, now())`, [rows[0].id, companyId]);
      await c.query('COMMIT');
      return rows[0].id;
    } finally {
      await c.end();
    }
  }
  const notificationsFor = (userId: string) => sql(notificationDb.url, `SELECT id, "sourceService", "sourceEventId" FROM notification WHERE "recipientId" = $1`, [userId]);
  const startAuth = async () => {
    auth = spawnService('auth', AUTH_DIR, authEnv);
    await waitForHealth(`${AUTH_URL}/auth/health`, 30_000);
  };

  beforeAll(async () => {
    authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauth21c2');
    notificationDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2enotif21c2');
    const dir = `${AUTH_DIR}/db/migrations`;
    for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) await sql(authDb.url, readFileSync(join(dir, f), 'utf8'));
    await runMigrations(notificationDb.url, [kitMigrationsDir, `${NOTIFICATION_DIR}/db/migrations/`]);
    await sql(authDb.url, `INSERT INTO company(id, name) VALUES ($1, 'E2E Co')`, [companyId]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    await deleteQueues();
    notification = spawnService('notification', NOTIFICATION_DIR, {
      NODE_ENV: 'test', PORT: String(NOTIFICATION_PORT), DATABASE_URL: notificationDb.url, RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      NOTIFICATION_SECRET_KEYS: `k1:${rand()}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1', NOTIFICATION_DEFAULT_LOCALE: 'en', NOTIFICATION_REQUEST_HASH_KEY: rand(),
    });
    await waitFor(async () => (await fetch(`${NOTIFICATION_URL}/ready`).catch(() => undefined))?.status === 200, 30_000, 'notification-service ready');
    // Auth reaches the broker only through a proxy the test can cut (Notification talks to the broker directly).
    const target = new URL(env.TEST_RABBITMQ_URL);
    proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    const viaProxy = new URL(env.TEST_RABBITMQ_URL);
    viaProxy.host = `127.0.0.1:${proxy.port}`;
    authEnv = {
      NODE_ENV: 'test', PORT: String(AUTH_PORT), DATABASE_URL: authDb.url, AUTH_EVENTS: 'on', RABBITMQ_URL: viaProxy.toString(), RABBITMQ_CONFIRM_TIMEOUT_MS: '500',
      JWT_SECRET: rand(), OPERATOR_CODE_PEPPER: rand(), SECRET_KEY_PEPPER: rand(), THROTTLE_KEY_PEPPER: rand(), JOIN_CODE_PEPPER: rand(),
      TOTP_ENCRYPTION_KEYS: `k1:${rand()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.test', WEBAUTHN_ORIGINS: 'https://auth.test',
      BCRYPT_COST: '4', WORK_TIMEZONE: 'UTC', ...Object.fromEntries(RATE_BUCKETS.map((b) => [`RATE_${b}_LIMIT`, '100000'])),
    };
    await startAuth();
  });

  afterAll(async () => {
    await auth?.stop();
    await notification?.stop();
    await proxy?.sever();
    await deleteQueues().catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await authDb?.drop();
    await notificationDb?.drop();
  });

  it('committed while the broker is unreachable, the process KILLED, restarted: the event is delivered to Notification, once', async () => {
    await proxy.sever();
    const email = `op-${randomUUID().slice(0, 8)}@example.test`;
    const userId = await operator(email);
    const r = await fetch(`${AUTH_URL}/auth/admin/login/operator/request-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    expect(r.status).toBe(204); // the Auth request never depends on the broker
    const rows = await sql(authDb.url, `SELECT id, payload, "publishedAt" FROM outbox WHERE name = 'admin.operator_code_issued' AND payload->>'destination' = $1`, [email]);
    expect(rows).toHaveLength(1);
    expect(rows[0].publishedAt).toBeNull(); // committed intent, nothing published
    Object.assign(crashed, { rowId: rows[0].id, userId, payload: rows[0].payload });

    await auth.kill(); // the crash the fire-and-forget publisher lost events to
    await new Promise((res) => setTimeout(res, 500));
    expect(await notificationsFor(userId)).toHaveLength(0);
    expect((await sql(authDb.url, `SELECT "publishedAt" FROM outbox WHERE id = $1`, [crashed.rowId]))[0].publishedAt).toBeNull();

    await proxy.start();
    await startAuth(); // a new process on the same database: its relay finds the committed row
    await waitFor(async () => (await notificationsFor(userId)).length === 1, 40_000, 'the event committed before the crash reaches Notification');
    const [n] = await notificationsFor(userId);
    expect(n).toMatchObject({ sourceService: 'auth-service', sourceEventId: crashed.rowId });
  });

  it('after publication the code-bearing outbox row is purged (no plaintext code kept as event history)', async () => {
    await waitFor(async () => (await sql(authDb.url, `SELECT 1 FROM outbox WHERE id = $1`, [crashed.rowId])).length === 0, 30_000, 'the published code row is deleted');
    expect((await sql(authDb.url, `SELECT count(*)::int AS n FROM outbox WHERE name = 'admin.operator_code_issued'`))[0].n).toBe(0);
  });

  it('a duplicate delivery of the same event id (a relay crash between publish and stamp) creates no second notification', async () => {
    const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL });
    try {
      const envelope = {
        id: crashed.rowId!, name: 'admin.operator_code_issued', payload: crashed.payload!,
        headers: { eventId: crashed.rowId!, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1 },
      };
      await bus.publish(envelope);
      await bus.publish(envelope);
    } finally {
      await bus.close();
    }
    await waitFor(async () => notification.tail().includes(`notification_duplicate eventId=${crashed.rowId}`), 20_000, 'Notification reports the duplicate');
    expect(await notificationsFor(crashed.userId!)).toHaveLength(1);
    expect((await sql(notificationDb.url, `SELECT count(*)::int AS n FROM notification WHERE "sourceEventId" = $1`, [crashed.rowId]))[0].n).toBe(1);
  });

  it('no one-time code reaches either service\'s log', async () => {
    const code = String(crashed.payload!.code);
    expect(code).toMatch(/^\d{6}$/);
    expect(`${auth.tail()}\n${notification.tail()}`).not.toContain(code);
  });
});

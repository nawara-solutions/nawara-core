import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 16.5 — the REAL flow, two live processes and a real broker, no synthetic event:
 *
 *   Auth HTTP request → auth-service (AUTH_EVENTS on) → canonical envelope on nawara.events → notification-service consumer
 *   (queue notification.events) → notification + delivery in the Notification database
 *
 * Each service runs from its own built `dist/main.js`; neither's source is imported here (scripts/lib/checks.mjs). Proves the mapping,
 * the template, the locale, the channel, the destination snapshot, the sealed code (and that it opens to the code Auth generated),
 * zero attempts and zero provider calls, the D20 rule on a phone Auth accepts but that is not E.164, and no code, destination or
 * credential in either service's log.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w auth-service -w notification-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const NOTIFICATION_DIR = `${ROOT}apps/notification-service`;
const AUTH_PORT = 13211;
const NOTIFICATION_PORT = 13212;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const NOTIFICATION_URL = `http://127.0.0.1:${NOTIFICATION_PORT}`;
const QUEUE = 'notification.events';
const rand = () => randomBytes(32).toString('base64');
const SECRET_KEY = randomBytes(32);

/** auth-service's own tracked-SQL migrations (copied from the Auth-Organization suite: sequential, sorted, a throwaway database). */
async function applyAuthMigrations(databaseUrl: string): Promise<void> {
  const dir = `${AUTH_DIR}/db/migrations`;
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) await c.query(readFileSync(join(dir, f), 'utf8'));
  } finally {
    await c.end();
  }
}

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

/** Opens a sealed notification secret (the documented layout: version | nonce(12) | ciphertext | tag(16), AAD nawara.notification.v1|<id>). */
function openSecret(sealed: Buffer, notificationId: string): Record<string, string> {
  const d = createDecipheriv('aes-256-gcm', SECRET_KEY, sealed.subarray(1, 13));
  d.setAAD(Buffer.from(`nawara.notification.v1|${notificationId}`));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return JSON.parse(Buffer.concat([d.update(sealed.subarray(13, sealed.length - 16)), d.final()]).toString('utf8'));
}

describeWithEnv('Stage 16.5: real Auth → real RabbitMQ → real Notification intake', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let authDb: TestDatabase;
  let notificationDb: TestDatabase;
  let auth: LiveService;
  let notification: LiveService;
  let conn: ChannelModel;
  const companyId = randomUUID();

  const deleteQueues = async () => {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    for (const q of [QUEUE, `${QUEUE}.retry`, `${QUEUE}.dead`]) await ch.deleteQueue(q).catch(() => undefined);
    await ch.close().catch(() => undefined);
  };
  /** A confirmed operator, created as Auth's `UsersService.createOperator` does: the user and its subtype in ONE transaction. */
  async function operator(contact: { email?: string; phone?: string }): Promise<string> {
    const c = new pg.Client({ connectionString: authDb.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`INSERT INTO "user"(kind, email, phone, role) VALUES ('operator', $1, $2, 'admin') RETURNING id`, [contact.email ?? null, contact.phone ?? null]);
      await c.query(`INSERT INTO operator("userId","companyId","contactVerifiedAt") VALUES ($1, $2, now())`, [rows[0].id, companyId]);
      await c.query('COMMIT');
      return rows[0].id;
    } finally {
      await c.end();
    }
  }
  async function requestCode(contact: { email?: string; phone?: string }): Promise<void> {
    const r = await fetch(`${AUTH_URL}/auth/admin/login/operator/request-code`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-e2e-auth-notification' }, body: JSON.stringify(contact) });
    expect(r.status).toBe(204);
  }
  async function intentFor(userId: string) {
    await waitFor(async () => (await sql(notificationDb.url, `SELECT 1 FROM notification WHERE "recipientId" = $1`, [userId])).length === 1, 20_000, `a notification for ${userId}`);
    const [n] = await sql(notificationDb.url, `SELECT n.*, t.key FROM notification n JOIN notification_template t ON t.id = n."templateId" WHERE n."recipientId" = $1`, [userId]);
    const d = await sql(notificationDb.url, `SELECT d.*, v.version FROM notification_delivery d JOIN notification_template_version v ON v.id = d."templateVersionId" WHERE d."notificationId" = $1`, [n.id]);
    return { n, d };
  }

  beforeAll(async () => {
    authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauth165');
    notificationDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2enotif165');
    await applyAuthMigrations(authDb.url);
    await runMigrations(notificationDb.url, [kitMigrationsDir, `${NOTIFICATION_DIR}/db/migrations/`]);
    await sql(authDb.url, `INSERT INTO company(id, name) VALUES ($1, 'E2E Co')`, [companyId]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    await deleteQueues();
    notification = spawnService('notification', NOTIFICATION_DIR, {
      NODE_ENV: 'test', PORT: String(NOTIFICATION_PORT), DATABASE_URL: notificationDb.url, RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      NOTIFICATION_SECRET_KEYS: `k1:${SECRET_KEY.toString('base64')}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1', NOTIFICATION_DEFAULT_LOCALE: 'en',
    });
    auth = spawnService('auth', AUTH_DIR, {
      NODE_ENV: 'test', PORT: String(AUTH_PORT), DATABASE_URL: authDb.url, AUTH_EVENTS: 'on', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      JWT_SECRET: rand(), OPERATOR_CODE_PEPPER: rand(), SECRET_KEY_PEPPER: rand(), THROTTLE_KEY_PEPPER: rand(), JOIN_CODE_PEPPER: rand(),
      TOTP_ENCRYPTION_KEYS: `k1:${rand()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.test', WEBAUTHN_ORIGINS: 'https://auth.test',
      BCRYPT_COST: '4', WORK_TIMEZONE: 'UTC', ...Object.fromEntries(RATE_BUCKETS.map((b) => [`RATE_${b}_LIMIT`, '100000'])),
    });
    await waitForHealth(`${AUTH_URL}/auth/health`, 30_000);
    await waitFor(async () => (await fetch(`${NOTIFICATION_URL}/ready`).catch(() => undefined))?.status === 200, 30_000, 'notification-service ready (database, migrations, broker, intake)');
  });

  afterAll(async () => {
    await auth?.stop();
    await notification?.stop();
    await deleteQueues().catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await authDb?.drop();
    await notificationDb?.drop();
  });

  it('an operator code requested by email becomes a PENDING EMAIL delivery on identity.operator_login_code, with the code sealed', async () => {
    const email = `op-${randomUUID().slice(0, 8)}@example.test`;
    const userId = await operator({ email });
    await requestCode({ email });
    const { n, d } = await intentFor(userId);
    expect(n).toMatchObject({ sourceKind: 'event', sourceService: 'auth-service', key: 'identity.operator_login_code', category: 'SECURITY', recipientType: 'user',
      organizationId: null, requestedLocale: null, correlationId: 'corr-e2e-auth-notification', secretKeyId: 'k1' });
    expect(n.expiresAt).not.toBeNull();
    expect(Object.keys(n.data)).toEqual(['expiresAt']); // the code is not in data
    const { code } = openSecret(n.secretCiphertext, n.id);
    expect(code).toMatch(/^\d{6}$/); // the code Auth generated, recoverable only through the key ring
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ channel: 'EMAIL', destination: email, locale: 'en', version: 1, status: 'PENDING', attempts: 0 });
    const logs = `${auth.tail()}\n${notification.tail()}`;
    expect(logs).toContain('notification_accepted');
    for (const s of [code, email, SECRET_KEY.toString('base64')]) expect(logs).not.toContain(s);
  });

  it('an operator code requested by an E.164 phone becomes a PENDING SMS delivery', async () => {
    const phone = `+2162${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const userId = await operator({ phone });
    await requestCode({ phone });
    const { n, d } = await intentFor(userId);
    expect(d[0]).toMatchObject({ channel: 'SMS', destination: phone, status: 'PENDING', templateVersionId: expect.any(String) });
    const { code } = openSecret(n.secretCiphertext, n.id);
    const logs = `${auth.tail()}\n${notification.tail()}`;
    for (const s of [code, phone]) expect(logs).not.toContain(s);
  });

  it('D20: a phone Auth accepts but that is not E.164 (no +) is recorded, its delivery FAILED invalid_destination, never prefixed, no code kept', async () => {
    const phone = `2162${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const userId = await operator({ phone });
    await requestCode({ phone });
    const { n, d } = await intentFor(userId);
    expect(d[0]).toMatchObject({ channel: 'SMS', destination: phone, status: 'FAILED', failureCode: 'invalid_destination', attempts: 0 });
    expect(n.secretCiphertext).toBeNull();
  });

  it('nothing was sent: zero attempts, nothing left the PENDING / FAILED(invalid_destination) states, nothing dead-lettered', async () => {
    expect((await sql(notificationDb.url, 'SELECT count(*)::int AS n FROM notification_delivery_attempt'))[0].n).toBe(0);
    expect((await sql(notificationDb.url, `SELECT count(*)::int AS n FROM notification_delivery WHERE status NOT IN ('PENDING', 'FAILED')`))[0].n).toBe(0);
    const ch = await conn.createChannel();
    try {
      expect((await ch.checkQueue(`${QUEUE}.dead`)).messageCount).toBe(0);
    } finally {
      await ch.close();
    }
  });
});

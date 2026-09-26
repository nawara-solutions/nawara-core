import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { waitFor, waitForHealth } from './support/process.js';

/**
 * Stage 21.C.3 (focused certification of Stage 21.C.2): live auth-service and notification-service processes, a real broker, real
 * databases. Certifies, with FULL log capture of both processes (not a tail):
 *   §18 broker outage durability, timed; §20 AUTH_EVENTS on -> off -> on (a committed row is relayed while off; nothing is written while off;
 *   nothing is replayed or duplicated when on again); §22 canary one-time codes never reach a log, an error, Audit, Notification's plain
 *   columns, the DLQ tool's output or the outbox-lag tool's output; §23 the DLQ tool redacts a secret-named field and still shows ordinary
 *   ones; §21/§24 code rows are purged once published or expired.
 * Prerequisite: `npm run build -w @nawara/service-kit -w auth-service -w notification-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const NOTIFICATION_DIR = `${ROOT}apps/notification-service`;
const KIT_DIR = `${ROOT}libs/service-kit`;
const AUTH_PORT = 13241;
const NOTIFICATION_PORT = 13242;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const QUEUE = 'notification.events';
const rand = () => randomBytes(32).toString('base64');
const RATE_BUCKETS = [
  'LOGIN_IP', 'LOGIN_IDENTIFIER', 'REGISTER_IP', 'REFRESH_IP', 'OWNER_VERIFY_OWNER', 'OWNER_VERIFY_IP', 'STEP_UP_OWNER', 'STEP_UP_IP',
  'FACTOR_ENROLL_OWNER', 'RECOVERY_IP', 'RECOVERY_IDENTIFIER', 'OPERATOR_REQUEST_IDENTIFIER', 'OPERATOR_REQUEST_IP', 'OPERATOR_VERIFY_IDENTIFIER',
  'OPERATOR_VERIFY_IP', 'OPERATOR_VERIFY_GLOBAL', 'OPERATOR_CONFIRM_IP',
  'JOIN_CODE_RESOLVE_IP', 'JOIN_CODE_RESOLVE_GLOBAL', 'JOIN_CODE_MANAGE_ACTOR', 'MEMBERSHIP_OP_ACTOR', 'MEMBERSHIP_JOIN_USER', 'CONTACT_REQUEST_USER', 'CONTACT_VERIFY_USER', 'CONTACT_VERIFY_IP',
  'INVITATION_RESOLVE_IP', 'INVITATION_RESOLVE_GLOBAL', 'INVITATION_ACCEPT_IP', 'INVITATION_MANAGE_ACTOR',
];
/** Canary one-time codes: distinctive strings that must never appear outside the short-lived outbox row and the broker. */
const CANARY_DLQ = `C4NARY-DLQ-${randomBytes(4).toString('hex')}`;
const CANARY_OK = `QZ${randomBytes(4).toString('hex')}`; // a valid code value (<= 12 characters)
const CANARY_LAG = `C4NARY-LAG-${randomBytes(4).toString('hex')}`;

async function sql<R extends pg.QueryResultRow = any>(url: string, text: string, params: unknown[] = []): Promise<R[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<R>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** A live process with its COMPLETE stdout/stderr kept (the shared helper keeps a 200-line tail only). */
function live(name: string, cwd: string, env: NodeJS.ProcessEnv) {
  const lines: string[] = [];
  const child: ChildProcess = spawn('node', ['dist/main.js'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const push = (b: Buffer) => { for (const l of b.toString('utf8').split('\n')) if (l.trim()) lines.push(`[${name}] ${l}`); };
  child.stdout!.on('data', push);
  child.stderr!.on('data', push);
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  return {
    lines,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(t);
    },
  };
}

describeWithEnv('Stage 21.C.3: Auth outbox certification across live processes', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let authDb: TestDatabase;
  let notificationDb: TestDatabase;
  let proxy: BrokerProxy;
  let conn: ChannelModel;
  let auth: ReturnType<typeof live>;
  let notification: ReturnType<typeof live>;
  const allLines: string[] = [];
  const companyId = randomUUID();
  const realCodes = new Set<string>();
  const timings: Record<string, number> = {};
  let authEnvBase: NodeJS.ProcessEnv;

  const startAuth = async (events: 'on' | 'off') => {
    auth = live(`auth-${events}`, AUTH_DIR, { ...authEnvBase, AUTH_EVENTS: events });
    await waitForHealth(`${AUTH_URL}/auth/health`, 30_000);
  };
  const stopAuth = async () => {
    await auth.stop();
    allLines.push(...auth.lines);
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
  async function requestCode(): Promise<{ userId: string; ms: number }> {
    const email = `op-${randomUUID().slice(0, 8)}@example.test`;
    const userId = await operator(email);
    const t0 = Date.now();
    const r = await fetch(`${AUTH_URL}/auth/admin/login/operator/request-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    expect(r.status).toBe(204);
    return { userId, ms: Date.now() - t0 };
  }
  const domainRows = (userId: string) => sql(authDb.url, `SELECT id, "publishedAt", payload->>'code' AS code FROM outbox WHERE name = 'admin.operator_code_issued' AND payload->>'userId' = $1`, [userId]);
  const notificationsFor = (userId: string) => sql(notificationDb.url, `SELECT "sourceEventId" FROM notification WHERE "recipientId" = $1`, [userId]);
  const enqueueDirect = (id: string, payload: Record<string, unknown>) =>
    sql(authDb.url, `INSERT INTO outbox (id, name, payload) VALUES ($1, 'admin.operator_code_issued', $2::jsonb)`, [id, JSON.stringify(payload)]);

  beforeAll(async () => {
    authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauth21c3');
    notificationDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2enotif21c3');
    const dir = `${AUTH_DIR}/db/migrations`;
    for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) await sql(authDb.url, readFileSync(join(dir, f), 'utf8'));
    await runMigrations(notificationDb.url, [kitMigrationsDir, `${NOTIFICATION_DIR}/db/migrations/`]);
    await sql(authDb.url, `INSERT INTO company(id, name) VALUES ($1, 'Cert Co')`, [companyId]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    const ch = await conn.createChannel();
    for (const q of [QUEUE, `${QUEUE}.retry`, `${QUEUE}.dead`]) await ch.deleteQueue(q).catch(() => undefined);
    await ch.close().catch(() => undefined);
    notification = live('notification', NOTIFICATION_DIR, {
      NODE_ENV: 'test', PORT: String(NOTIFICATION_PORT), DATABASE_URL: notificationDb.url, RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      NOTIFICATION_SECRET_KEYS: `k1:${rand()}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1', NOTIFICATION_DEFAULT_LOCALE: 'en', NOTIFICATION_REQUEST_HASH_KEY: rand(),
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${NOTIFICATION_PORT}/ready`).catch(() => undefined))?.status === 200, 30_000, 'notification ready');
    const target = new URL(env.TEST_RABBITMQ_URL);
    proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    const viaProxy = new URL(env.TEST_RABBITMQ_URL);
    viaProxy.host = `127.0.0.1:${proxy.port}`;
    authEnvBase = {
      NODE_ENV: 'test', PORT: String(AUTH_PORT), DATABASE_URL: authDb.url, RABBITMQ_URL: viaProxy.toString(), RABBITMQ_CONFIRM_TIMEOUT_MS: '500',
      JWT_SECRET: rand(), OPERATOR_CODE_PEPPER: rand(), SECRET_KEY_PEPPER: rand(), THROTTLE_KEY_PEPPER: rand(), JOIN_CODE_PEPPER: rand(),
      TOTP_ENCRYPTION_KEYS: `k1:${rand()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.test', WEBAUTHN_ORIGINS: 'https://auth.test',
      BCRYPT_COST: '4', WORK_TIMEZONE: 'UTC', ...Object.fromEntries(RATE_BUCKETS.map((b) => [`RATE_${b}_LIMIT`, '100000'])),
    };
    await startAuth('on');
  }, 120_000);

  afterAll(async () => {
    await auth?.stop();
    await notification?.stop();
    await proxy?.sever();
    const ch = await conn.createChannel();
    for (const q of [QUEUE, `${QUEUE}.retry`, `${QUEUE}.dead`]) await ch.deleteQueue(q).catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await authDb?.drop();
    await notificationDb?.drop();
    console.log(`21.C.3 timings (ms): ${JSON.stringify(timings)}`);
  });

  it('§18 broker outage: the request returns at once, the row stays pending, and after recovery Notification records it exactly once', async () => {
    await proxy.sever();
    const { userId, ms } = await requestCode();
    timings.requestDuringOutage = ms;
    expect(ms).toBeLessThan(2_000);
    const [row] = await domainRows(userId);
    expect(row.publishedAt).toBeNull();
    realCodes.add(row.code);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await notificationsFor(userId)).toHaveLength(0);
    const t0 = Date.now();
    await proxy.start();
    await waitFor(async () => (await notificationsFor(userId)).length === 1, 60_000, 'delivery after recovery');
    timings.recoveryToNotification = Date.now() - t0;
    expect((await notificationsFor(userId))[0].sourceEventId).toBe(row.id);
  });

  it('§20 AUTH_EVENTS: a row committed while on is relayed after the switch to off; nothing is written while off; on again replays nothing', async () => {
    await proxy.sever();
    const pending = await requestCode(); // committed while ON, broker unreachable
    const [pendingRow] = await domainRows(pending.userId);
    realCodes.add(pendingRow.code);
    expect(pendingRow.publishedAt).toBeNull();
    await stopAuth();
    await proxy.start();
    await startAuth('off');
    await waitFor(async () => (await notificationsFor(pending.userId)).length === 1, 60_000, 'the committed row is relayed while AUTH_EVENTS=off');
    const whileOff = await requestCode();
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await domainRows(whileOff.userId)).toHaveLength(0); // no domain-event row while off
    expect(await notificationsFor(whileOff.userId)).toHaveLength(0);
    expect((await sql(authDb.url, `SELECT count(*)::int AS n FROM auth_audit_event WHERE type = 'operator.code.issued' AND "actorId" = $1`, [whileOff.userId]))[0].n).toBe(1); // the change itself happened
    await stopAuth();
    await startAuth('on');
    const again = await requestCode();
    await waitFor(async () => (await notificationsFor(again.userId)).length === 1, 60_000, 'a new row after on again');
    const [againRow] = await sql(notificationDb.url, `SELECT "sourceEventId" FROM notification WHERE "recipientId" = $1`, [again.userId]);
    await new Promise((r) => setTimeout(r, 3_000));
    const dup = await sql(notificationDb.url, `SELECT "sourceEventId", count(*)::int AS n FROM notification WHERE "sourceKind" = 'event' GROUP BY 1 HAVING count(*) > 1`);
    expect(dup).toEqual([]); // no logical duplicate across the switches
    expect(await notificationsFor(pending.userId)).toHaveLength(1); // not replayed on again
    expect(againRow.sourceEventId).not.toBe(pendingRow.id);
  }, 180_000);

  it('§22/§23 canaries: a rejected code event is dead-lettered, and the DLQ tool shows its ordinary fields but never the code', async () => {
    const uid = randomUUID();
    await enqueueDirect(randomUUID(), { userId: uid, channel: 'fax', destination: 'x@example.test', code: CANARY_DLQ, expiresAt: new Date(Date.now() + 600_000).toISOString(), timestamp: new Date().toISOString() });
    await waitFor(async () => {
      const ch = await conn.createChannel();
      try { return (await ch.checkQueue(`${QUEUE}.dead`)).messageCount >= 1; } finally { await ch.close().catch(() => undefined); }
    }, 30_000, 'the malformed code event is dead-lettered');
    const dlq = spawnSync('node', ['dist/cli/dlq.js', 'list', '--queue', `${QUEUE}.dead`, '--field', 'code', '--field', 'channel', '--field', 'userId'], { cwd: KIT_DIR, env: { ...process.env, RABBITMQ_URL: env.TEST_RABBITMQ_URL }, encoding: 'utf8' });
    const out = `${dlq.stdout}\n${dlq.stderr}`;
    allLines.push(out);
    expect(dlq.status, out).toBe(0);
    expect(out).toContain('code=redacted');
    expect(out).toContain('channel=fax'); // an ordinary diagnostic field stays useful
    expect(out).toContain(`userId=${uid}`);
    expect(out).not.toContain(CANARY_DLQ);
  });

  it('§22 a valid canary code is delivered sealed: Notification keeps no plaintext copy', async () => {
    const operatorId = await operator(`canary-${randomUUID().slice(0, 6)}@example.test`);
    await enqueueDirect(randomUUID(), { userId: operatorId, channel: 'email', destination: 'canary@example.test', code: CANARY_OK, expiresAt: new Date(Date.now() + 600_000).toISOString(), timestamp: new Date().toISOString() });
    await waitFor(async () => (await notificationsFor(operatorId)).length === 1, 30_000, 'the canary notification');
    const plain = JSON.stringify(await sql(notificationDb.url, `SELECT n.data, n."requestedLocale", d.destination, d."failureCode" FROM notification n JOIN notification_delivery d ON d."notificationId" = n.id WHERE n."recipientId" = $1`, [operatorId]));
    expect(plain).not.toContain(CANARY_OK);
    expect((await sql(notificationDb.url, `SELECT "secretCiphertext" IS NOT NULL AS sealed FROM notification WHERE "recipientId" = $1`, [operatorId]))[0].sealed).toBe(true);
  });

  it('§22 the outbox-lag tool shows a pending code row by id and name only', async () => {
    await proxy.sever();
    await enqueueDirect(randomUUID(), { userId: randomUUID(), channel: 'email', destination: 'lag@example.test', code: CANARY_LAG, expiresAt: new Date(Date.now() + 600_000).toISOString(), timestamp: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 3_000)); // at least one failed publish attempt
    const lag = spawnSync('node', ['dist/cli/check-outbox-lag.js', '--max-age-seconds', '0'], { cwd: KIT_DIR, env: { ...process.env, DATABASE_URL: authDb.url }, encoding: 'utf8' });
    const out = `${lag.stdout}\n${lag.stderr}`;
    allLines.push(out);
    expect(out).toMatch(/pending: [1-9]/);
    expect(out).not.toContain(CANARY_LAG);
    await proxy.start();
  });

  it('§21/§24 every code-bearing row is purged once published or expired, and no canary or real code reached any log, Audit or tool output', async () => {
    await waitFor(async () => (await sql(authDb.url, `SELECT count(*)::int AS n FROM outbox WHERE name IN ('member.contact_verification_requested','admin.operator_code_issued','admin.operator_confirmation_code_issued')`))[0].n === 0, 60_000, 'code rows purged');
    await stopAuth();
    allLines.push(...notification.lines);
    const everything = allLines.join('\n');
    expect(everything).toMatch(/auth_code_event_purge deleted=\d+ published=\d+ expired=\d+/);
    const audit = JSON.stringify(await sql(authDb.url, `SELECT payload FROM outbox WHERE name LIKE 'audit.%'`)) + JSON.stringify(await sql(authDb.url, `SELECT * FROM auth_audit_event`));
    const secrets = [CANARY_DLQ, CANARY_OK, CANARY_LAG, ...[...realCodes].filter(Boolean)];
    expect(secrets.length).toBeGreaterThanOrEqual(5);
    for (const s of secrets) {
      expect(everything.includes(s), 'a code reached a log or tool output').toBe(false);
      expect(audit.includes(s), 'a code reached Audit').toBe(false);
    }
    await startAuth('on'); // leave a running process for afterAll symmetry
  }, 120_000);
});

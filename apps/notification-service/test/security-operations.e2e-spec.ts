import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { DeliveryWorker, type PassResult } from '../src/delivery/delivery-worker.js';
import { DestinationLimiter, destinationIdentity } from '../src/delivery/destination-limiter.js';
import { OpsReporter } from '../src/delivery/ops-reporter.js';
import type { ChannelProvider, ProviderCallContext, ProviderResult } from '../src/delivery/provider.js';
import type { RenderedMessage } from '../src/delivery/renderer.js';
import { RetentionWorker } from '../src/delivery/retention.worker.js';
import { retirementVerdict, secretKeyUsage } from '../src/delivery/secret-keys.js';
import { SecretPurgeWorker } from '../src/delivery/secret-purge.worker.js';
import { TEST_DESTINATION_LIMIT_KEY, TEST_REQUEST_HASH_KEY, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { closedPortUrl } from './support/provider-stub.js';

/**
 * Stage 16.9: the security and operational mechanisms on a real PostgreSQL: the HMAC destination limiter (D21), request-hash key
 * rotation, the secret-key lifecycle and retirement check, the operational snapshot, retention of limiter state, readiness under a
 * provider outage, and the durable-backoff bound that stands in for a circuit breaker.
 */
const A = generateServiceToken();
const TOKENS = [{ caller: 'core-caller-a', digest: A.digest }];
const OTP = '903117';
const EMAIL = 'ops-probe@example.test';
const PHONE = '+21698700001';
const b64 = (b: Buffer) => b.toString('base64');
const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const blank = (): PassResult => ({ recovered: 0, claimed: 0, sent: 0, retried: 0, failed: 0, unconfirmed: 0, resent: 0, expired: 0, cancelled: 0 });

class Fake implements ChannelProvider {
  readonly id = 'fake';
  readonly capabilities = { idempotencyKey: false };
  calls: { destination: string; text: string }[] = [];
  behavior: (m: RenderedMessage, ctx: ProviderCallContext) => ProviderResult | Promise<ProviderResult> = (_m, ctx) => ({ kind: 'accepted', providerMessageId: `f-${ctx.attemptId}` });
  constructor(readonly channel: 'EMAIL' | 'SMS') {}
  async send(m: RenderedMessage, ctx: ProviderCallContext): Promise<ProviderResult> {
    this.calls.push({ destination: m.destination, text: m.text });
    return this.behavior(m, ctx);
  }
}

describeWithEnv('notification security and operations (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const email = new Fake('EMAIL');
  const sms = new Fake('SMS');
  const apps: TestApp[] = [];
  /** Nest's static Logger follows the LAST application created: log assertions search every application ever created. */
  const every: TestApp[] = [];
  const logs = () => every.flatMap((a) => a.logs);

  const app = async (over: Record<string, string> = {}, opts: { providers?: boolean } = {}) => {
    const a = await createTestApp({
      databaseUrl: db.url, tokens: TOKENS,
      env: { NOTIFICATION_WORKER_INTERVAL_MS: '60000', NOTIFICATION_RETRY_BASE_MS: '1000', NOTIFICATION_RETRY_CEILING_MS: '4000', NOTIFICATION_MAX_ATTEMPTS: '3', ...over },
      providers: opts.providers === false ? undefined : { EMAIL: email, SMS: sms },
    });
    apps.push(a);
    every.push(a);
    await a.app.get(DeliveryWorker).stopPolling();
    await a.app.get(SecretPurgeWorker).stopPolling();
    await a.app.get(OpsReporter).stopPolling();
    await a.app.get(RetentionWorker).stopPolling();
    return a;
  };
  const send = async (body: Record<string, unknown>, target = t, key = `k-${randomUUID()}`) =>
    request(target.app.getHttpServer()).post('/notification/notifications').set('authorization', `Bearer ${A.token}`).set('idempotency-key', key).send(body);
  const alert = async (channels: { channel: string; destination: string }[], target = t) => {
    const r = await send({ template: 'membership.approved', channels }, target);
    if (r.status !== 202) throw new Error(`refused ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const code = async (target = t, channels = [{ channel: 'SMS', destination: PHONE }]) => {
    const r = await send({ template: 'identity.contact_verification_code', channels, data: { code: OTP, expiresAt: future(600_000) }, expiresAt: future(600_000) }, target);
    if (r.status !== 202) throw new Error(`refused ${r.status}`);
    return r.body.id as string;
  };
  const statusOf = async (nid: string) => (await sql<{ status: string; failureCode: string | null }>(db.url, `SELECT status, "failureCode" FROM notification_delivery WHERE "notificationId" = $1`, [nid]))[0];
  const quiesce = async () => {
    await sql(db.url, `UPDATE notification_delivery SET status = 'CANCELLED', "nextAttemptAt" = NULL, "completedAt" = now() WHERE status = 'PENDING'`);
    await sql(db.url, `UPDATE notification_delivery SET status = 'FAILED', "leaseUntil" = NULL, "failedAt" = now(), "completedAt" = now(), "failureCode" = 'test_cleanup' WHERE status = 'SENDING'`);
    await sql(db.url, `DELETE FROM kit_rate_limit`);
  };
  const drain = async (w: DeliveryWorker) => {
    for (let i = 0; i < 20; i++) if ((await w.passOnce()).claimed === 0) break;
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifsecops');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    t = await app({ NOTIFICATION_RATE_DESTINATION_LIMIT: '3' });
  });
  beforeEach(async () => {
    email.calls = [];
    sms.calls = [];
    email.behavior = (_m, ctx) => ({ kind: 'accepted', providerMessageId: `f-${ctx.attemptId}` });
    sms.behavior = email.behavior;
    await quiesce();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const a of apps.splice(1)) await a.app.close();
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── D21: destination limiter

  describe('D21 destination limiter (notif_dest)', () => {
    it('at most NOTIFICATION_RATE_DESTINATION_LIMIT sends per channel + destination per window; others unaffected; logged with the bucket', async () => {
      const same = [];
      for (let i = 0; i < 5; i++) same.push(await alert([{ channel: 'EMAIL', destination: EMAIL }]));
      const other = await alert([{ channel: 'EMAIL', destination: 'someone-else@example.test' }]);
      const smsOne = await alert([{ channel: 'SMS', destination: PHONE }]);
      await drain(t.app.get(DeliveryWorker));
      const statuses = await Promise.all(same.map(statusOf));
      expect(statuses.filter((s) => s.status === 'SENT')).toHaveLength(3);
      expect(statuses.filter((s) => s.status === 'FAILED' && s.failureCode === 'rate_limited')).toHaveLength(2);
      expect((await statusOf(other)).status).toBe('SENT');
      expect((await statusOf(smsOne)).status).toBe('SENT');
      expect(email.calls.filter((c) => c.destination === EMAIL)).toHaveLength(3);
      expect(logs().some((l) => String(l.msg).includes('code=rate_limited') && String(l.msg).includes('bucket=notif_dest'))).toBe(true);
    });

    it('the destination is keyed exactly as accepted: +tags, case and dots are different destinations (no aggressive normalization)', async () => {
      const a = await app({ NOTIFICATION_RATE_DESTINATION_LIMIT: '1' });
      const variants = ['first.last@example.test', 'firstlast@example.test', 'First.Last@example.test', 'first.last+tag@example.test'];
      const ids = [];
      for (const d of variants) ids.push(await alert([{ channel: 'EMAIL', destination: d }], a));
      await drain(a.app.get(DeliveryWorker));
      for (const id of ids) expect((await statusOf(id)).status).toBe('SENT');
      const again = await alert([{ channel: 'EMAIL', destination: variants[0] }], a);
      await drain(a.app.get(DeliveryWorker));
      expect(await statusOf(again)).toEqual({ status: 'FAILED', failureCode: 'rate_limited' });
    });

    it('atomic under concurrency: 50 simultaneous decisions for one destination allow exactly the limit', async () => {
      const a = await app({ NOTIFICATION_RATE_DESTINATION_LIMIT: '7' });
      const limiter = a.app.get(DestinationLimiter);
      const results = await Promise.all(Array.from({ length: 50 }, () => limiter.allow('SMS', PHONE)));
      expect(results.filter(Boolean)).toHaveLength(7);
    });

    it('atomic across competing workers: 24 deliveries to one destination, 3 workers → exactly the limit sent', async () => {
      const w = await Promise.all([app({ NOTIFICATION_RATE_DESTINATION_LIMIT: '5' }), app({ NOTIFICATION_RATE_DESTINATION_LIMIT: '5' }), app({ NOTIFICATION_RATE_DESTINATION_LIMIT: '5' })]);
      const ids = [];
      for (let i = 0; i < 24; i++) ids.push(await alert([{ channel: 'SMS', destination: PHONE }]));
      await Promise.all(w.map((a) => drain(a.app.get(DeliveryWorker))));
      const statuses = await Promise.all(ids.map(statusOf));
      expect(statuses.filter((s) => s.status === 'SENT')).toHaveLength(5);
      expect(statuses.filter((s) => s.failureCode === 'rate_limited')).toHaveLength(19);
      expect(sms.calls).toHaveLength(5);
    });

    it('privacy: the stored limiter key is sha256("notif_dest:" + HMAC(dedicated key, …)); no plain hash of any guessable form of the destination', async () => {
      await alert([{ channel: 'SMS', destination: PHONE }]);
      await alert([{ channel: 'EMAIL', destination: EMAIL }]);
      await drain(t.app.get(DeliveryWorker));
      const stored = (await sql<{ key: string }>(db.url, `SELECT key FROM kit_rate_limit WHERE bucket = 'notif_dest' ORDER BY key`)).map((r) => r.key).sort();
      const expected = [['SMS', PHONE], ['EMAIL', EMAIL]].map(([c, d]) => createHash('sha256').update(`notif_dest:${destinationIdentity(TEST_DESTINATION_LIMIT_KEY, c, d)}`).digest('hex')).sort();
      expect(stored).toEqual(expected);
      const guesses = [PHONE, PHONE.slice(1), EMAIL, `SMS|${PHONE}`, `EMAIL|${EMAIL}`, `SMS:${PHONE}`];
      const plain = guesses.flatMap((g) => [createHash('sha256').update(g).digest('hex'), createHash('sha256').update(`notif_dest:${g}`).digest('hex')]);
      expect(stored.filter((k) => plain.includes(k))).toEqual([]);
      // and the HMAC under any other key (for example the request-hash key) does not reproduce it
      const wrong = createHash('sha256').update(`notif_dest:${createHmac('sha256', TEST_REQUEST_HASH_KEY).update(`nawara.notification.destination-limit.v1|SMS|${PHONE}`).digest('hex')}`).digest('hex');
      expect(stored).not.toContain(wrong);
      const dump = JSON.stringify(await sql(db.url, `SELECT row_to_json(x) AS r FROM kit_rate_limit x`));
      expect(dump).not.toContain(PHONE);
      expect(dump).not.toContain(EMAIL);
    });

    it('rotation: with the new key current and the old one previous, a destination keeps its count (no burst); the old key alone is not needed after a window', async () => {
      const k1 = randomBytes(32);
      const k2 = randomBytes(32);
      const old = await app({ NOTIFICATION_DESTINATION_LIMIT_KEY: b64(k1), NOTIFICATION_RATE_DESTINATION_LIMIT: '2' });
      expect(await old.app.get(DestinationLimiter).allow('SMS', PHONE)).toBe(true);
      expect(await old.app.get(DestinationLimiter).allow('SMS', PHONE)).toBe(true);
      const rotating = await app({ NOTIFICATION_DESTINATION_LIMIT_KEY: b64(k2), NOTIFICATION_DESTINATION_LIMIT_PREVIOUS_KEY: b64(k1), NOTIFICATION_RATE_DESTINATION_LIMIT: '2' });
      expect(await rotating.app.get(DestinationLimiter).allow('SMS', PHONE)).toBe(false); // the previous bucket is full
      // once the previous key is removed (after one window), the new key's bucket carries the hits made during the overlap
      const after = await app({ NOTIFICATION_DESTINATION_LIMIT_KEY: b64(k2), NOTIFICATION_RATE_DESTINATION_LIMIT: '2' });
      expect(await after.app.get(DestinationLimiter).allow('SMS', PHONE)).toBe(true); // 2nd hit on the new bucket
      expect(await after.app.get(DestinationLimiter).allow('SMS', PHONE)).toBe(false);
    });

    it('fails closed: a limiter failure sends nothing; the claim (no attempt) is recovered as PENDING and sent later', async () => {
      const nid = await alert([{ channel: 'EMAIL', destination: EMAIL }]);
      const w = t.app.get(DeliveryWorker);
      vi.spyOn(t.app.get(DestinationLimiter), 'allow').mockRejectedValueOnce(Object.assign(new Error('Connection terminated unexpectedly'), {}));
      const [c] = await w.claim();
      await expect(w.processOne(c, blank())).rejects.toThrow();
      expect(email.calls).toHaveLength(0);
      const [d] = await sql<Record<string, any>>(db.url, `SELECT id, status, attempts FROM notification_delivery WHERE "notificationId" = $1`, [nid]);
      expect(d).toMatchObject({ status: 'SENDING', attempts: 0 });
      await sql(db.url, `UPDATE notification_delivery SET "leaseUntil" = now() - interval '1 second' WHERE id = $1`, [d.id]);
      await drain(w);
      expect((await statusOf(nid)).status).toBe('SENT');
      expect(email.calls).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────── request-hash key rotation

  describe('request-hash key rotation', () => {
    const body = { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] };
    it('current key hashes; a retry made under the previous key replays; a changed body is 422; after the previous key is dropped the retry is 422 (never a second intent)', async () => {
      const ka = randomBytes(32);
      const kb = randomBytes(32);
      const before = await app({ NOTIFICATION_REQUEST_HASH_KEY: b64(ka) });
      const idem = `k-${randomUUID()}`;
      const first = await send(body, before, idem);
      expect(first.status).toBe(202);
      const [row] = await sql<{ h: string }>(db.url, `SELECT "requestHash" AS h FROM notification WHERE id = $1`, [first.body.id]);
      expect(row.h).toBe(createHmac('sha256', ka).update(`nawara.notification.api.v1|${JSON.stringify({ channels: [{ channel: 'EMAIL', destination: EMAIL }], template: 'membership.approved' })}`).digest('hex'));

      const rotated = await app({ NOTIFICATION_REQUEST_HASH_KEY: b64(kb), NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS: b64(ka) });
      const retry = await send(body, rotated, idem);
      expect(retry.status).toBe(202);
      expect(retry.body.id).toBe(first.body.id);
      expect((await send({ ...body, channels: [{ channel: 'EMAIL', destination: 'other@example.test' }] }, rotated, idem)).status).toBe(422);
      const fresh = await send(body, rotated);
      const [h2] = await sql<{ h: string }>(db.url, `SELECT "requestHash" AS h FROM notification WHERE id = $1`, [fresh.body.id]);
      expect(h2.h).toBe(createHmac('sha256', kb).update(`nawara.notification.api.v1|${JSON.stringify({ channels: [{ channel: 'EMAIL', destination: EMAIL }], template: 'membership.approved' })}`).digest('hex'));

      const retired = await app({ NOTIFICATION_REQUEST_HASH_KEY: b64(kb) });
      const late = await send(body, retired, idem);
      expect(late.status).toBe(422);
      expect(late.body.code).toBe('idempotency_key_reused');
      expect((await sql(db.url, `SELECT 1 FROM notification WHERE "idempotencyKey" = $1`, [idem]))).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── secret-encryption key lifecycle

  describe('secret-encryption key lifecycle', () => {
    it('add k2 as active: new codes use k2, old k1 codes still deliver; k1 is retirable only once no live ciphertext references it', async () => {
      const k1 = `k1:${b64(randomBytes(32))}`;
      const k2 = `k2:${b64(randomBytes(32))}`;
      const v1 = await app({ NOTIFICATION_SECRET_KEYS: k1, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1' });
      const oldCode = await code(v1);
      const v2 = await app({ NOTIFICATION_SECRET_KEYS: `${k1},${k2}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k2' });
      const newCode = await code(v2, [{ channel: 'EMAIL', destination: EMAIL }]);
      const ids = await sql<{ id: string; k: string }>(db.url, `SELECT id, "secretKeyId" AS k FROM notification WHERE id = ANY($1::uuid[]) ORDER BY k`, [[oldCode, newCode]]);
      expect(ids.map((r) => r.k)).toEqual(['k1', 'k2']);
      expect(await retirementVerdict(v2.app.get(OpsReporter)['db'], 'k1', 'k2')).toEqual({ safe: false, reason: 'live_ciphertext', liveCiphertexts: 1 });
      expect(await retirementVerdict(v2.app.get(OpsReporter)['db'], 'k2', 'k2')).toEqual({ safe: false, reason: 'active_key' });
      await drain(v2.app.get(DeliveryWorker));
      expect((await statusOf(oldCode)).status).toBe('SENT'); // decrypted with k1
      expect(sms.calls[0].text).toContain(OTP);
      expect(await secretKeyUsage(v2.app.get(OpsReporter)['db'])).toEqual([]); // purged at terminal state
      expect(await retirementVerdict(v2.app.get(OpsReporter)['db'], 'k1', 'k2')).toEqual({ safe: true });
    });

    it('a key removed too early is detected (error signal) and its codes fail safely instead of being sent', async () => {
      const k1 = `k1:${b64(randomBytes(32))}`;
      const k2 = `k2:${b64(randomBytes(32))}`;
      const v1 = await app({ NOTIFICATION_SECRET_KEYS: k1, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1' });
      const orphan = await code(v1);
      const tooEarly = await app({ NOTIFICATION_SECRET_KEYS: k2, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k2' });
      const s = await tooEarly.app.get(OpsReporter).report();
      expect(s.missingSecretKeys).toEqual(['k1']);
      expect(logs().some((l) => l.level === 'error' && String(l.msg).startsWith('notification_secret_key_missing keyId=k1'))).toBe(true);
      await drain(tooEarly.app.get(DeliveryWorker));
      expect(await statusOf(orphan)).toEqual({ status: 'FAILED', failureCode: 'render_failed' });
      expect(sms.calls).toHaveLength(0);
    });

    it('the operator CLI prints key ids and counts only, and retire-check exits 3 while a key is live, 0 once purged', async () => {
      const cli = fileURLToPath(new URL('../dist/cli/secret-keys.js', import.meta.url));
      const run = (args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, DATABASE_URL: db.url, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 't1' } })
        .then((r) => ({ code: 0, out: r.stdout }), (e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout }));
      const nid = await code();
      const [{ c }] = await sql<{ c: Buffer }>(db.url, `SELECT "secretCiphertext" AS c FROM notification WHERE id = $1`, [nid]);
      const usage = await run(['usage']);
      expect(usage.code).toBe(0);
      expect(JSON.parse(usage.out)).toEqual([expect.objectContaining({ keyId: 't1', liveCiphertexts: 1, anyWithoutExpiry: false })]);
      expect(usage.out).not.toContain(c.toString('hex'));
      expect(usage.out).not.toContain(c.toString('base64'));
      expect(usage.out).not.toContain(new URL(db.url).password || 'none');
      expect((await run(['retire-check', 'old-key'])).code).toBe(0);
      expect((await run(['retire-check', 't1'])).code).toBe(3); // active and live
      await drain(t.app.get(DeliveryWorker));
      const after = await promisify(execFile)(process.execPath, [cli, 'retire-check', 't1'], { env: { ...process.env, DATABASE_URL: db.url } });
      expect(JSON.parse(after.stdout)).toEqual({ keyId: 't1', safe: true });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────── operational snapshot

  describe('operational snapshot', () => {
    it('counts the backlog by state from the partial indexes, with no destination, id or content in the line', async () => {
      const due = [await alert([{ channel: 'EMAIL', destination: EMAIL }]), await alert([{ channel: 'EMAIL', destination: EMAIL }])];
      await sql(db.url, `UPDATE notification_delivery SET "nextAttemptAt" = now() - interval '90 seconds' WHERE "notificationId" = $1`, [due[0]]);
      const retrying = await alert([{ channel: 'SMS', destination: PHONE }]);
      await sql(db.url, `UPDATE notification_delivery SET attempts = 1 WHERE "notificationId" = $1`, [retrying]);
      const r = await send({ template: 'membership.approved', scheduledAt: future(3_600_000), channels: [{ channel: 'EMAIL', destination: EMAIL }] });
      expect(r.status).toBe(202);
      const leased = await alert([{ channel: 'SMS', destination: '+21698700002' }]);
      const stale = await alert([{ channel: 'SMS', destination: '+21698700003' }]);
      for (const [nid, lease] of [[leased, "now() + interval '1 minute'"], [stale, "now() - interval '1 minute'"]]) {
        await sql(db.url, `UPDATE notification_delivery SET status = 'SENDING', "nextAttemptAt" = NULL, "leaseUntil" = ${lease} WHERE "notificationId" = $1`, [nid]);
      }
      await code();
      const s = await t.app.get(OpsReporter).report();
      expect(s).toMatchObject({ due: 4, retrying: 1, scheduled: 1, sending: 1, staleLeases: 1, liveSecrets: 1, missingSecretKeys: [] });
      expect(s.oldestDueAgeSec).toBeGreaterThanOrEqual(89);
      const line = logs().filter((l) => String(l.msg).startsWith('notification_ops_snapshot')).at(-1)!;
      expect(String(line.msg)).toMatch(/^notification_ops_snapshot due=4 oldestDueAgeSec=\d+ retrying=1 scheduled=1 sending=1 staleLeases=1 liveSecrets=1$/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────── retention

  describe('retention of limiter state', () => {
    it('deletes only expired windows of the buckets this service owns, in bounded batches; active windows and foreign buckets stay', async () => {
      const a = await app({ NOTIFICATION_RETENTION_BATCH_SIZE: '3', NOTIFICATION_RATE_DESTINATION_WINDOW_SEC: '3600' });
      const rows: Array<[string, string]> = [];
      for (let i = 0; i < 4; i++) rows.push(['notif_api_caller', "now() - interval '2 minutes'"]);
      rows.push(['notif_api_caller', "now() - interval '10 seconds'"]); // active
      rows.push(['notif_dest', "now() - interval '30 minutes'"]); // active for a 1 h window
      rows.push(['notif_dest', "now() - interval '2 hours'"]);
      rows.push(['notif_caller_template', "now() - interval '5 minutes'"]);
      rows.push(['someone_elses_bucket', "now() - interval '30 days'"]); // not ours: untouched
      for (const [bucket, at] of rows) await sql(db.url, `INSERT INTO kit_rate_limit (bucket, key, "windowStart", count) VALUES ($1, $2, ${at}, 1)`, [bucket, randomBytes(32).toString('hex')]);
      const w = a.app.get(RetentionWorker);
      expect(await w.deleteExpiredWindows()).toBe(3); // one bounded batch
      expect(await w.cleanOnce()).toBe(3); // the rest (6 expired in all)
      const left = await sql<{ bucket: string; n: number }>(db.url, `SELECT bucket, count(*)::int AS n FROM kit_rate_limit GROUP BY bucket ORDER BY bucket`);
      expect(left).toEqual([{ bucket: 'notif_api_caller', n: 1 }, { bucket: 'notif_dest', n: 1 }, { bucket: 'someone_elses_bucket', n: 1 }]);
      expect(await w.cleanOnce()).toBe(0); // idempotent
    });

    it('a row a limiter hit holds is skipped, not waited for (SKIP LOCKED); a database failure leaves everything for the next pass', async () => {
      const a = await app();
      const key = randomBytes(32).toString('hex');
      await sql(db.url, `INSERT INTO kit_rate_limit (bucket, key, "windowStart", count) VALUES ('notif_api_caller', $1, now() - interval '5 minutes', 1)`, [key]);
      const pg = await import('pg');
      const c = new pg.default.Client({ connectionString: db.url });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT 1 FROM kit_rate_limit WHERE key = $1 FOR UPDATE`, [key]);
        const t0 = Date.now();
        expect(await a.app.get(RetentionWorker).cleanOnce()).toBe(0);
        expect(Date.now() - t0).toBeLessThan(1000);
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
      const w = a.app.get(RetentionWorker);
      vi.spyOn(w, 'deleteExpiredWindows').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
      await expect(w.cleanOnce()).rejects.toThrow();
      vi.restoreAllMocks();
      expect(await w.cleanOnce()).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────── degradation, readiness, circuit breaker

  describe('provider degradation', () => {
    it('a provider outage is not a readiness failure: /ready stays 200 while deliveries back off durably', async () => {
      const down = await closedPortUrl();
      const a = await createTestApp({
        databaseUrl: db.url, tokens: TOKENS,
        env: {
          NOTIFICATION_EMAIL_PROVIDER: 'resend', NOTIFICATION_RESEND_API_KEY: 're_ReadinessProbe_0123456789', NOTIFICATION_EMAIL_FROM: 'n@notify.example.com', NOTIFICATION_RESEND_BASE_URL: down,
          NOTIFICATION_WORKER_INTERVAL_MS: '60000',
        },
      });
      apps.push(a);
      every.push(a);
      await a.app.get(DeliveryWorker).stopPolling();
      await vi.waitFor(async () => { const r = await request(a.app.getHttpServer()).get('/ready'); expect(r.status, JSON.stringify(r.body)).toBe(200); }, { timeout: 15_000, interval: 100 });
      const nid = await alert([{ channel: 'EMAIL', destination: EMAIL }], a);
      await a.app.get(DeliveryWorker).passOnce();
      expect(await statusOf(nid)).toEqual({ status: 'PENDING', failureCode: 'provider_unreachable' });
      const ready = await request(a.app.getHttpServer()).get('/ready');
      expect(ready.status).toBe(200);
      expect(JSON.stringify(ready.body)).not.toMatch(/resend|twilio|provider/i);
    });

    it('no circuit breaker is needed: under a total outage each delivery makes at most NOTIFICATION_MAX_ATTEMPTS spaced calls, then stops', async () => {
      email.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: 'provider_unavailable' });
      const ids = [];
      for (let i = 0; i < 10; i++) ids.push(await alert([{ channel: 'EMAIL', destination: `outage-${i}@example.test` }]));
      const w = t.app.get(DeliveryWorker);
      await w.passOnce();
      expect(email.calls).toHaveLength(10);
      await w.passOnce();
      expect(email.calls).toHaveLength(10); // nothing is due: the backoff is durable, no hot loop
      for (let round = 0; round < 5; round++) {
        await sql(db.url, `UPDATE notification_delivery SET "nextAttemptAt" = now() WHERE "notificationId" = ANY($1::uuid[]) AND status = 'PENDING'`, [ids]);
        await w.passOnce();
      }
      expect(email.calls).toHaveLength(30); // 10 deliveries x 3 attempts, whatever the number of passes
      for (const id of ids) expect(await statusOf(id)).toEqual({ status: 'FAILED', failureCode: 'retries_exhausted' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────── leaks

  it('leak scan: no key, destination, code or content from these mechanisms in the logs; the limiter table holds no destination', async () => {
    await code();
    await alert([{ channel: 'EMAIL', destination: EMAIL }]);
    await drain(t.app.get(DeliveryWorker));
    await t.app.get(OpsReporter).report();
    const all = JSON.stringify(logs());
    for (const s of [OTP, EMAIL, PHONE, b64(TEST_DESTINATION_LIMIT_KEY), TEST_DESTINATION_LIMIT_KEY.toString('hex'), b64(TEST_REQUEST_HASH_KEY), A.token]) {
      expect(all.includes(s), 'log leak').toBe(false);
    }
    const limiter = JSON.stringify(await sql(db.url, `SELECT row_to_json(x) AS r FROM kit_rate_limit x`));
    for (const s of [EMAIL, PHONE, OTP]) expect(limiter.includes(s)).toBe(false);
  });
});

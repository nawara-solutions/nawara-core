import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { DeliveryWorker } from '../src/delivery/delivery-worker.js';
import { SecretPurgeWorker } from '../src/delivery/secret-purge.worker.js';
import { TEST_REQUEST_HASH_KEY, TEST_SECRET_KEYS, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { ProviderStub } from './support/provider-stub.js';

/**
 * Stage 16.8: the delivery engine with the REAL Resend and Twilio adapters, selected by configuration exactly as in production, talking
 * to a local HTTP stand-in for both APIs (no real provider, no network), on a real PostgreSQL.
 */
const A = generateServiceToken();
const TOKENS = [{ caller: 'core-caller-a', digest: A.digest }];
const OTP = '615092';
const EMAIL = 'adapter-leak-probe@example.test';
const PHONE = '+21698765431';
const RESEND_KEY = 're_SentinelResendKeyE2E_0123456789';
const TW_SECRET = 'SentinelTwilioSecretE2E012345678';
const PII = 'provider-body-pii-sentinel@leak.example';
const SID = (n: number) => `SM${n.toString(16).padStart(32, '0')}`;
const AR_BODY = 'رمز التحقق الخاص بك هو {{code}}. صالح حتى {{expiresAt}}.';
const future = (ms: number) => new Date(Date.now() + ms).toISOString();

describeWithEnv('real provider adapters in the delivery engine (stub APIs, real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let worker: DeliveryWorker;
  const stub = new ProviderStub();
  const every: TestApp[] = [];
  const logs = () => JSON.stringify(every.flatMap((a) => a.logs));

  const providerEnv = (over: Record<string, string> = {}) => ({
    NOTIFICATION_EMAIL_PROVIDER: 'resend', NOTIFICATION_RESEND_API_KEY: RESEND_KEY, NOTIFICATION_EMAIL_FROM: 'Nawara <no-reply@notify.example.com>',
    NOTIFICATION_RESEND_BASE_URL: stub.url,
    NOTIFICATION_SMS_PROVIDER: 'twilio', NOTIFICATION_TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, NOTIFICATION_TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
    NOTIFICATION_TWILIO_API_KEY_SECRET: TW_SECRET, NOTIFICATION_TWILIO_MESSAGING_SERVICE_SID: `MG${'3'.repeat(32)}`, NOTIFICATION_TWILIO_BASE_URL: stub.url,
    NOTIFICATION_WORKER_INTERVAL_MS: '60000', NOTIFICATION_PROVIDER_TIMEOUT_MS: '400', NOTIFICATION_LEASE_MS: '5000',
    NOTIFICATION_RETRY_BASE_MS: '1000', NOTIFICATION_RETRY_CEILING_MS: '30000', NOTIFICATION_MAX_ATTEMPTS: '3',
    NOTIFICATION_RATE_DESTINATION_LIMIT: '100000',
    ...over,
  });
  const makeApp = async (over: Record<string, string> = {}, stop = true) => {
    const a = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, env: providerEnv(over) });
    every.push(a);
    if (stop) {
      await a.app.get(DeliveryWorker).stopPolling();
      await a.app.get(SecretPurgeWorker).stopPolling();
    }
    return a;
  };
  const send = async (body: Record<string, unknown>) => {
    const r = await request(t.app.getHttpServer()).post('/notification/notifications').set('authorization', `Bearer ${A.token}`).set('idempotency-key', `k-${randomUUID()}`).send(body);
    if (r.status !== 202) throw new Error(`send refused: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const code = (channels: { channel: string; destination: string }[], over: Record<string, unknown> = {}) =>
    send({ template: 'identity.contact_verification_code', channels, data: { code: OTP, expiresAt: future(600_000) }, expiresAt: future(600_000), ...over });
  const one = async (nid: string, channel: string) =>
    (await sql<Record<string, any>>(db.url, `SELECT * FROM notification_delivery WHERE "notificationId" = $1 AND channel = $2`, [nid, channel]))[0];
  const attempts = (did: string) => sql<Record<string, any>>(db.url, `SELECT * FROM notification_delivery_attempt WHERE "deliveryId" = $1 ORDER BY "attemptNumber"`, [did]);
  const secret = async (nid: string) => (await sql<{ c: Buffer | null }>(db.url, `SELECT "secretCiphertext" AS c FROM notification WHERE id = $1`, [nid]))[0].c;
  const quiesce = async () => {
    await sql(db.url, `UPDATE notification_delivery SET status = 'CANCELLED', "nextAttemptAt" = NULL, "completedAt" = now() WHERE status = 'PENDING'`);
    await sql(db.url, `UPDATE notification_delivery SET status = 'FAILED', "leaseUntil" = NULL, "failedAt" = now(), "completedAt" = now(), "failureCode" = 'test_cleanup' WHERE status = 'SENDING'`);
  };
  /** Both APIs answer from one stand-in: Resend on /emails, Twilio on /2010-04-01/…; `n` counts per API. */
  const route = (resend: (n: number) => any, twilio: (n: number) => any) => {
    let e = 0;
    let s = 0;
    stub.behaviour = (req) => (req.path === '/emails' ? resend(++e) : twilio(++s));
  };
  const emails = () => stub.requests.filter((r) => r.path === '/emails');
  const texts = () => stub.requests.filter((r) => r.path.startsWith('/2010-04-01/'));

  beforeAll(async () => {
    await stub.start();
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifadapters');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    t = await makeApp();
    worker = t.app.get(DeliveryWorker);
  });
  beforeEach(async () => {
    stub.reset();
    await quiesce();
  });
  afterEach(async () => {
    for (const a of every.splice(1)) await a.app.close();
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
    await stub.close();
  });

  it('the configured providers are the real adapters: resend for EMAIL, twilio for SMS', async () => {
    const nid = await code([{ channel: 'EMAIL', destination: EMAIL }, { channel: 'SMS', destination: PHONE }]);
    route(() => ({ kind: 'json', status: 200, body: { id: 'resend-id-1' } }), () => ({ kind: 'json', status: 201, body: { sid: SID(1) } }));
    expect(await worker.passOnce()).toMatchObject({ claimed: 2, sent: 2 });
    expect(await one(nid, 'EMAIL')).toMatchObject({ status: 'SENT', provider: 'resend', providerMessageId: 'resend-id-1' });
    expect(await one(nid, 'SMS')).toMatchObject({ status: 'SENT', provider: 'twilio', providerMessageId: SID(1) });
    expect((await attempts((await one(nid, 'SMS')).id))[0]).toMatchObject({ outcome: 'ACCEPTED', provider: 'twilio', providerMessageId: SID(1) });
    expect(await secret(nid)).toBeNull();
    // the rendered content, with the code, reached each API exactly once
    expect(JSON.parse(emails()[0].body)).toMatchObject({ to: [EMAIL], subject: 'Your verification code' });
    expect(JSON.parse(emails()[0].body).text).toContain(OTP);
    expect(new URLSearchParams(texts()[0].body).get('Body')).toContain(OTP);
    expect(emails()[0].headers['idempotency-key']).toBe(`nawara-notification/${(await one(nid, 'EMAIL')).id}/0`);
  });

  it('Arabic: a published ar version renders and reaches Twilio byte-exact (UCS-2 is the provider’s concern)', async () => {
    const [v] = await sql<Record<string, any>>(db.url,
      `SELECT v."templateId" FROM notification_template_version v JOIN notification_template t ON t.id = v."templateId" WHERE t.key = 'identity.contact_verification_code' AND v.channel = 'SMS' AND v.locale = 'en'`);
    await sql(db.url, `INSERT INTO notification_template_version ("templateId", channel, locale, version, variables, "bodyText", "smsMaxSegments", checksum)
      SELECT "templateId", 'SMS', 'ar', 1, variables, $2, 2, $3 FROM notification_template_version WHERE "templateId" = $1 AND channel = 'SMS' AND locale = 'en' AND version = 1`,
      [v.templateId, AR_BODY, 'd'.repeat(64)]).catch(() => undefined); // idempotent across reruns in one database
    const nid = await code([{ channel: 'SMS', destination: PHONE }], { locale: 'ar' });
    stub.behaviour = { kind: 'json', status: 201, body: { sid: SID(2) } };
    await worker.passOnce();
    expect(await one(nid, 'SMS')).toMatchObject({ status: 'SENT', locale: 'ar' });
    const body = new URLSearchParams(texts()[0].body).get('Body')!;
    expect(body.startsWith(`رمز التحقق الخاص بك هو ${OTP}. صالح حتى `)).toBe(true);
  });

  it('Resend idempotency: an ambiguous send is resent with the SAME key (the provider can deduplicate); after a definite answer the key changes', async () => {
    const nid = await code([{ channel: 'EMAIL', destination: EMAIL }]);
    const did = (await one(nid, 'EMAIL')).id;
    route((n) => (n === 1 ? { kind: 'reset' } : { kind: 'json', status: 200, body: { id: 'resend-original-id' } }), () => ({ kind: 'hang' }));
    await worker.passOnce(); // the connection is lost after the request: ambiguous → §8.5, one resend of the code
    expect(await one(nid, 'EMAIL')).toMatchObject({ status: 'PENDING', ambiguousResends: 1, failureCode: 'provider_connection_lost' });
    await worker.passOnce(); // Resend would return the ORIGINAL id for the same key: no second email
    expect(await one(nid, 'EMAIL')).toMatchObject({ status: 'SENT', providerMessageId: 'resend-original-id' });
    expect(emails().map((r) => r.headers['idempotency-key'])).toEqual([`nawara-notification/${did}/0`, `nawara-notification/${did}/0`]);

    stub.reset();
    const nid2 = await code([{ channel: 'EMAIL', destination: EMAIL }]);
    const did2 = (await one(nid2, 'EMAIL')).id;
    route((n) => (n === 1 ? { kind: 'json', status: 500, body: { name: 'application_error' } } : { kind: 'json', status: 200, body: { id: 'resend-id-2' } }), () => ({ kind: 'hang' }));
    await worker.passOnce();
    await sql(db.url, `UPDATE notification_delivery SET "nextAttemptAt" = now() WHERE id = $1`, [did2]);
    await worker.passOnce();
    expect(emails().map((r) => r.headers['idempotency-key'])).toEqual([`nawara-notification/${did2}/0`, `nawara-notification/${did2}/1`]);
    expect(await one(nid2, 'EMAIL')).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('Twilio (no idempotency key): an ambiguous code is resent once; an ambiguous alert is UNCONFIRMED and never resent', async () => {
    const codeId = await code([{ channel: 'SMS', destination: PHONE }]);
    stub.behaviour = (_r, n) => (n === 1 ? { kind: 'raw', status: 504, body: 'Gateway Timeout' } : { kind: 'json', status: 201, body: { sid: SID(3) } });
    await worker.passOnce();
    await worker.passOnce();
    expect(await one(codeId, 'SMS')).toMatchObject({ status: 'SENT', ambiguousResends: 1, attempts: 2 });
    expect(texts()).toHaveLength(2);
    expect(texts()[0].body).toBe(texts()[1].body); // the same code

    stub.reset();
    const alertId = await send({ template: 'membership.approved', channels: [{ channel: 'SMS', destination: PHONE }] });
    stub.behaviour = { kind: 'reset' };
    await worker.passOnce();
    await worker.passOnce();
    expect(await one(alertId, 'SMS')).toMatchObject({ status: 'UNCONFIRMED', failureClass: 'ambiguous', failureCode: 'provider_connection_lost' });
    expect(texts()).toHaveLength(1);
  });

  it('429 with Retry-After: retryable, the worker persists nextAttemptAt from the hint (bounded); no immediate retry', async () => {
    const nid = await send({ template: 'membership.approved', channels: [{ channel: 'SMS', destination: PHONE }] });
    stub.behaviour = { kind: 'json', status: 429, headers: { 'retry-after': '20' }, body: { code: 20429, message: 'Too Many Requests' } };
    const t0 = Date.now();
    await worker.passOnce();
    const d = await one(nid, 'SMS');
    expect(d).toMatchObject({ status: 'PENDING', failureClass: 'retryable', failureCode: 'provider_rate_limited' });
    expect(d.nextAttemptAt.getTime() - t0).toBeGreaterThanOrEqual(20_000 - 100);
    expect(d.nextAttemptAt.getTime() - t0).toBeLessThanOrEqual(30_000 + 500); // the ceiling
    await worker.passOnce();
    expect(texts()).toHaveLength(1);
    expect(logs()).toContain('httpStatus=429 providerCode=20429');
  });

  it('terminal destination rejection and a provider auth fault (alerted, retryable, bounded); no credential or provider text anywhere', async () => {
    const rejected = await send({ template: 'membership.approved', channels: [{ channel: 'SMS', destination: PHONE }] });
    const auth = await send({ template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] });
    route(() => ({ kind: 'json', status: 401, body: { name: 'missing_api_key', message: `bad key ${RESEND_KEY} for ${PII}` } }),
      () => ({ kind: 'json', status: 400, body: { code: 21211, message: `Invalid 'To' ${PHONE} ${PII}` } }));
    await worker.passOnce();
    expect(await one(rejected, 'SMS')).toMatchObject({ status: 'FAILED', failureClass: 'terminal', failureCode: 'destination_rejected' });
    expect(await one(auth, 'EMAIL')).toMatchObject({ status: 'PENDING', failureClass: 'retryable', failureCode: 'provider_auth_fault' });
    const all = every.flatMap((a) => a.logs);
    expect(all.some((l) => String(l.msg).startsWith('provider_auth_fault') && l.level === 'error')).toBe(true);
    for (const s of [RESEND_KEY, TW_SECRET, PII, PHONE, EMAIL, OTP]) expect(logs().includes(s), 'log leak').toBe(false);
  });

  it('timeout: a hanging API is cut at NOTIFICATION_PROVIDER_TIMEOUT_MS, recorded AMBIGUOUS provider_timeout, and its socket is closed', async () => {
    const nid = await send({ template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] });
    stub.behaviour = { kind: 'hang' };
    const t0 = Date.now();
    await worker.passOnce();
    expect(Date.now() - t0).toBeLessThan(400 + 1500);
    expect(await one(nid, 'EMAIL')).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'provider_timeout' });
    await new Promise((r) => setTimeout(r, 100));
    expect(stub.clientAborts).toBe(1);
  });

  it('a caller cannot choose the sender: a from / sender field on the API is refused', async () => {
    for (const field of ['from', 'sender', 'messagingServiceSid', 'provider']) {
      const r = await request(t.app.getHttpServer()).post('/notification/notifications').set('authorization', `Bearer ${A.token}`).set('idempotency-key', `k-${randomUUID()}`)
        .send({ template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }], [field]: 'attacker@evil.test' });
      expect(r.status, field).toBe(400);
    }
  });

  it('nothing of a provider response is persisted: only the bounded id, code and timing', async () => {
    const nid = await code([{ channel: 'EMAIL', destination: EMAIL }, { channel: 'SMS', destination: PHONE }]);
    route(() => ({ kind: 'json', status: 200, body: { id: 'resend-id-9', echo: PII, object: 'email' } }),
      () => ({ kind: 'json', status: 201, body: { sid: SID(9), body: `echo ${PII} ${OTP}`, to: PHONE, account_sid: `AC${'1'.repeat(32)}` } }));
    await worker.passOnce();
    const tables = await sql<{ t: string }>(db.url, `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`);
    for (const { t: table } of tables) {
      const dump = JSON.stringify(await sql(db.url, `SELECT row_to_json(x) AS r FROM "${table}" x`));
      for (const s of [PII, OTP, RESEND_KEY, TW_SECRET, `AC${'1'.repeat(32)}`]) expect(dump.includes(s), `${table}`).toBe(false);
    }
    expect((await one(nid, 'EMAIL')).providerMessageId).toBe('resend-id-9');
  });

  it('shutdown during a real-adapter call: the call finishes within the timeout, its outcome is persisted, and no provider socket lingers', async () => {
    const a = await makeApp({ NOTIFICATION_WORKER_INTERVAL_MS: '100', NOTIFICATION_PROVIDER_TIMEOUT_MS: '2000' }, false);
    const nid = await send({ template: 'membership.approved', channels: [{ channel: 'SMS', destination: PHONE }] });
    let reached!: () => void;
    const called = new Promise<void>((r) => (reached = r));
    stub.behaviour = () => {
      reached();
      return { kind: 'json', status: 201, body: { sid: SID(7) }, delayMs: 500 };
    };
    await called;
    const t0 = Date.now();
    await a.app.close();
    every.splice(every.indexOf(a), 1);
    expect(Date.now() - t0).toBeLessThan(2000 + 2000);
    expect(await one(nid, 'SMS')).toMatchObject({ status: 'SENT', providerMessageId: SID(7) });
  });

  it('shutdown during a HANGING real-adapter call: cut by the timeout, recorded AMBIGUOUS, bounded close', async () => {
    const a = await makeApp({ NOTIFICATION_WORKER_INTERVAL_MS: '100' }, false);
    const nid = await send({ template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] });
    let reached!: () => void;
    const called = new Promise<void>((r) => (reached = r));
    stub.behaviour = () => {
      reached();
      return { kind: 'hang' };
    };
    await called;
    const t0 = Date.now();
    await a.app.close();
    every.splice(every.indexOf(a), 1);
    expect(Date.now() - t0).toBeLessThan(400 + 2000);
    expect(await one(nid, 'EMAIL')).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'provider_timeout' });
    await new Promise((r) => setTimeout(r, 100));
    expect(stub.clientAborts).toBe(1);
  });

  it('keys and credentials used by the service never reach logs or the database', async () => {
    const dump = JSON.stringify(await sql(db.url, `SELECT row_to_json(x) AS r FROM notification x`));
    for (const s of [TEST_SECRET_KEYS.split(':')[1], TEST_REQUEST_HASH_KEY.toString('base64'), A.token, RESEND_KEY, TW_SECRET]) {
      expect(logs().includes(s)).toBe(false);
      expect(dump.includes(s)).toBe(false);
    }
  });
});

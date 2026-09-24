import { createHash, randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RabbitMqEventBus, generateServiceToken, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { DeliveryWorker } from '../src/delivery/delivery-worker.js';
import { destinationIdentity } from '../src/delivery/destination-limiter.js';
import { OpsReporter } from '../src/delivery/ops-reporter.js';
import { RetentionWorker } from '../src/delivery/retention.worker.js';
import { SecretPurgeWorker } from '../src/delivery/secret-purge.worker.js';
import { INTAKE_QUEUE } from '../src/intake/event-map.js';
import { TEST_DESTINATION_LIMIT_KEY, TEST_REQUEST_HASH_KEY, TEST_SECRET_KEYS, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { ProviderStub } from './support/provider-stub.js';

/**
 * Stage 16.10: the Notification V1 focused certification, INTEGRATED. One application exactly as production wires it: the real kit
 * RabbitMQ consumer (queue notification.events), the send API behind service tokens, the delivery engine with the REAL Resend and Twilio
 * adapters (selected by configuration) talking to a local stand-in for both APIs, the destination limiter, on a real PostgreSQL.
 * Every flow goes from intake to a terminal delivery state. Unit-level and single-mechanism proofs live in the 16.3–16.9 suites; this
 * suite proves they compose.
 */
const EXCHANGE_QUEUES = [INTAKE_QUEUE, `${INTAKE_QUEUE}.retry`, `${INTAKE_QUEUE}.dead`];
const A = generateServiceToken();
const B = generateServiceToken();
const POLICY = JSON.stringify({
  callers: {
    'cert-caller-a': { templates: ['identity.contact_verification_code', 'membership.approved'], channels: ['EMAIL', 'SMS'], organizations: 'request' },
    'cert-caller-b': { templates: ['membership.approved'], channels: ['EMAIL'], organizations: 'none' },
  },
});
const TOKENS = [{ caller: 'cert-caller-a', digest: A.digest }, { caller: 'cert-caller-b', digest: B.digest }];
const OTP = '482719';
const EMAIL = 'cert-sentinel@example.test';
const PHONE = '+21698765440';
const RESEND_KEY = 're_CertSentinelResendKey_0123456789';
const TW_SECRET = 'CertSentinelTwilioSecret01234567';
const PII = 'cert-provider-body-pii@leak.example';
const FR_SUBJECT = 'Votre code de vérification — à usage unique';
const AR_SMS = 'رمز التحقق الخاص بك هو {{code}}. لا تشاركه.';
const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const SID = (n: number) => `SM${n.toString(16).padStart(32, '0')}`;

describeWithEnv('Notification V1 focused certification (integrated: real RabbitMQ, real adapters, real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let db: TestDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let publisher: RabbitMqEventBus;
  let t: TestApp;
  const stub = new ProviderStub();
  const every: TestApp[] = [];
  const extra: TestApp[] = [];
  const logs = () => JSON.stringify(every.flatMap((a) => a.logs));
  let n = 0;

  const appEnv = (over: Record<string, string> = {}) => ({
    NOTIFICATION_EMAIL_PROVIDER: 'resend', NOTIFICATION_RESEND_API_KEY: RESEND_KEY, NOTIFICATION_EMAIL_FROM: 'Nawara <no-reply@notify.example.com>', NOTIFICATION_RESEND_BASE_URL: stub.url,
    NOTIFICATION_SMS_PROVIDER: 'twilio', NOTIFICATION_TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, NOTIFICATION_TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
    NOTIFICATION_TWILIO_API_KEY_SECRET: TW_SECRET, NOTIFICATION_TWILIO_MESSAGING_SERVICE_SID: `MG${'3'.repeat(32)}`, NOTIFICATION_TWILIO_BASE_URL: stub.url,
    NOTIFICATION_WORKER_INTERVAL_MS: '60000', NOTIFICATION_PROVIDER_TIMEOUT_MS: '1000', NOTIFICATION_LEASE_MS: '5000',
    NOTIFICATION_RETRY_BASE_MS: '1000', NOTIFICATION_RETRY_CEILING_MS: '4000', NOTIFICATION_MAX_ATTEMPTS: '3', NOTIFICATION_RATE_DESTINATION_LIMIT: '3',
    ...over,
  });
  const start = async (over: Record<string, string> = {}) => {
    const a = await createTestApp({ databaseUrl: db.url, bus: 'rabbitmq', tokens: TOKENS, policy: POLICY, env: appEnv(over) });
    every.push(a);
    for (const W of [DeliveryWorker, SecretPurgeWorker, OpsReporter, RetentionWorker]) await (a.app.get(W as never) as { stopPolling(): Promise<unknown> }).stopPolling();
    await vi.waitFor(async () => expect((await request(a.app.getHttpServer()).get('/ready')).status).toBe(200), { timeout: 20_000, interval: 100 });
    return a;
  };
  const post = (token: string, body: Record<string, unknown>, key = `k-${randomUUID()}`, target = t) =>
    request(target.app.getHttpServer()).post('/notification/notifications').set('authorization', `Bearer ${token}`).set('idempotency-key', key).send(body);
  const codeBody = (channels: { channel: string; destination: string }[], over: Record<string, unknown> = {}) =>
    ({ template: 'identity.contact_verification_code', channels, data: { code: OTP, expiresAt: future(600_000) }, expiresAt: future(600_000), ...over });
  const deliveries = (nid: string) => sql<Record<string, any>>(db.url, `SELECT * FROM notification_delivery WHERE "notificationId" = $1 ORDER BY channel`, [nid]);
  const attempts = (did: string) => sql<Record<string, any>>(db.url, `SELECT * FROM notification_delivery_attempt WHERE "deliveryId" = $1 ORDER BY "attemptNumber"`, [did]);
  const secret = async (nid: string) => (await sql<{ c: Buffer | null }>(db.url, `SELECT "secretCiphertext" AS c FROM notification WHERE id = $1`, [nid]))[0].c;
  const worker = (a = t) => a.app.get(DeliveryWorker);
  const drain = async (a = t) => {
    for (let i = 0; i < 20; i++) if ((await worker(a).passOnce()).claimed === 0) break;
  };
  const emails = () => stub.requests.filter((r) => r.path === '/emails');
  const texts = () => stub.requests.filter((r) => r.path.startsWith('/2010-04-01/'));
  const accept = () => {
    stub.behaviour = (req) => (req.path === '/emails' ? { kind: 'json', status: 200, body: { id: `resend-${++n}` } } : { kind: 'json', status: 201, body: { sid: SID(++n) } });
  };
  const envelope = (payload: Record<string, unknown>, name = 'member.contact_verification_requested'): EventEnvelope => {
    const id = randomUUID();
    return { id, name, payload, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1, correlationId: `cert-${id.slice(0, 8)}` } };
  };
  const intentFor = async (eventId: string) => {
    await vi.waitFor(async () => expect((await sql(db.url, `SELECT 1 FROM notification WHERE "sourceEventId" = $1`, [eventId])).length).toBe(1), { timeout: 20_000, interval: 100 });
    return (await sql<{ id: string }>(db.url, `SELECT id FROM notification WHERE "sourceEventId" = $1`, [eventId]))[0].id;
  };
  const publishVersion = async (key: string, channel: string, locale: string, subject: string | null, body: string, segments: number | null) => {
    await sql(db.url, `INSERT INTO notification_template_version ("templateId", channel, locale, version, variables, subject, "bodyText", "smsMaxSegments", checksum)
      SELECT v."templateId", $2, $3, 1, v.variables, $4, $5, $6, $7 FROM notification_template_version v JOIN notification_template t ON t.id = v."templateId"
       WHERE t.key = $1 AND v.channel = $2 AND v.locale = 'en' AND v.version = 1`, [key, channel, locale, subject, body, segments, createHash('sha256').update(`${key}|${channel}|${locale}`).digest('hex')]);
  };

  beforeAll(async () => {
    await stub.start();
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifcert');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    for (const q of EXCHANGE_QUEUES) await ch.deleteQueue(q).catch(() => undefined);
    publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL });
    // EN (published) + FR email and AR SMS versions for locale certification, and an Arabic SMS too long for its one segment.
    await publishVersion('identity.contact_verification_code', 'EMAIL', 'fr', FR_SUBJECT, 'Votre code : {{code}}. Il expire à {{expiresAt}}. Ne le partagez jamais.', null);
    await publishVersion('identity.contact_verification_code', 'SMS', 'ar', null, AR_SMS, 1);
    await publishVersion('membership.approved', 'SMS', 'ar', null, 'تمت الموافقة على طلب عضويتك. '.repeat(4), 1);
    t = await start();
  });
  beforeEach(async () => {
    stub.reset();
    accept();
    await sql(db.url, `UPDATE notification_delivery SET status = 'CANCELLED', "nextAttemptAt" = NULL, "completedAt" = now() WHERE status = 'PENDING'`);
    await sql(db.url, `DELETE FROM kit_rate_limit`);
  });
  afterEach(async () => {
    for (const a of extra.splice(0)) await a.app.close();
  });
  afterAll(async () => {
    await t?.app.close();
    await publisher?.close();
    for (const q of EXCHANGE_QUEUES) await ch?.deleteQueue(q).catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await db.drop();
    await stub.close();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────── API intake flows

  describe('API intake → delivery → provider → terminal state', () => {
    it('API → EMAIL (Resend): service token, policy, Idempotency-Key, pinned template, SENT, attempt ACCEPTED, secret purged; a replay is the same intent', async () => {
      const key = `k-${randomUUID()}`;
      const body = codeBody([{ channel: 'EMAIL', destination: EMAIL }]);
      const r = await post(A.token, body, key);
      expect(r.status).toBe(202);
      const replay = await post(A.token, body, key);
      expect(replay.status).toBe(202);
      expect(replay.body.id).toBe(r.body.id);
      expect(await sql(db.url, `SELECT 1 FROM notification WHERE "idempotencyKey" = $1`, [key])).toHaveLength(1);
      expect((await post(A.token, { ...body, data: { ...body.data, code: '000000' } }, key)).status).toBe(422); // same key, changed request
      const [plain] = await sql<{ c: Buffer; d: unknown }>(db.url, `SELECT "secretCiphertext" AS c, data AS d FROM notification WHERE id = $1`, [r.body.id]);
      expect(plain.c.includes(Buffer.from(OTP))).toBe(false); // sealed before persistence
      expect(JSON.stringify(plain.d)).not.toContain(OTP);
      await drain();
      const [d] = await deliveries(r.body.id);
      expect(d).toMatchObject({ channel: 'EMAIL', status: 'SENT', provider: 'resend', attempts: 1 });
      expect(d.providerMessageId).toMatch(/^resend-\d+$/);
      expect((await attempts(d.id)).map((a) => a.outcome)).toEqual(['ACCEPTED']);
      expect(await secret(r.body.id)).toBeNull();
      expect(emails()).toHaveLength(1);
      const sent = JSON.parse(emails()[0].body);
      expect(sent).toMatchObject({ from: 'Nawara <no-reply@notify.example.com>', to: [EMAIL], subject: 'Your verification code' });
      expect(sent.text).toContain(OTP); // decrypted only for the provider call
      expect(emails()[0].headers['idempotency-key']).toBe(`nawara-notification/${d.id}/0`);
      // disclosure: the status view has hints, never the destination, the code, a provider id or credentials
      const view = await request(t.app.getHttpServer()).get(`/notification/notifications/${r.body.id}`).set('authorization', `Bearer ${A.token}`);
      expect(view.status).toBe(200);
      expect(view.body.status).toBe('COMPLETED');
      for (const s of [EMAIL, OTP, d.providerMessageId, RESEND_KEY, 'secretKeyId', 'ciphertext', 'requestHash']) expect(JSON.stringify(view.body)).not.toContain(s);
    });

    it('API → SMS (Twilio): strict E.164 accepted and sent; local, 00-prefixed and +-less numbers are refused at intake, no country is guessed', async () => {
      const r = await post(A.token, codeBody([{ channel: 'SMS', destination: PHONE }]));
      expect(r.status).toBe(202);
      await drain();
      const [d] = await deliveries(r.body.id);
      expect(d).toMatchObject({ status: 'SENT', provider: 'twilio', destination: PHONE });
      const form = new URLSearchParams(texts()[0].body);
      expect(form.get('To')).toBe(PHONE);
      expect(form.get('Body')).toContain(OTP);
      expect(form.get('MessagingServiceSid')).toBe(`MG${'3'.repeat(32)}`);
      for (const local of ['98765440', '21698765440', '0021698765440', '+216 98 765 440']) {
        const bad = await post(A.token, codeBody([{ channel: 'SMS', destination: local }]));
        expect(bad.status, local).toBe(422);
        expect(bad.body.code).toBe('invalid_destination');
      }
      expect(await sql(db.url, `SELECT 1 FROM notification_delivery WHERE destination LIKE '+216%' AND destination <> $1`, [PHONE])).toEqual([]);
      expect(texts()).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────── event intake flows

  describe('RabbitMQ event intake → delivery → provider → terminal state', () => {
    it('Auth event (email) → notification.events → intent → EMAIL delivery → Resend → SENT; the message is acknowledged; a redelivered copy is a duplicate with no second send', async () => {
      const e = envelope({ userId: 'u-cert-1', channel: 'email', destination: EMAIL, code: OTP, expiresAt: future(600_000) });
      await publisher.publish(e);
      const nid = await intentFor(e.headers.eventId);
      await vi.waitFor(async () => expect((await ch.checkQueue(INTAKE_QUEUE)).messageCount).toBe(0), { timeout: 10_000, interval: 100 });
      await drain();
      const [d] = await deliveries(nid);
      expect(d).toMatchObject({ channel: 'EMAIL', status: 'SENT', provider: 'resend' });
      expect(JSON.parse(emails()[0].body).text).toContain(OTP);
      await publisher.publish(e); // the same envelope again (a broker redelivery / producer retry)
      await vi.waitFor(async () => expect(t.logs.some((l) => String(l.msg).includes('notification_duplicate') || String(l.msg).includes('duplicate'))).toBe(true), { timeout: 10_000, interval: 100 }).catch(() => undefined);
      await vi.waitFor(async () => expect((await ch.checkQueue(INTAKE_QUEUE)).messageCount).toBe(0), { timeout: 10_000, interval: 100 });
      await drain();
      expect(await sql(db.url, `SELECT 1 FROM notification WHERE "sourceEventId" = $1`, [e.headers.eventId])).toHaveLength(1);
      expect(emails()).toHaveLength(1);
      expect((await ch.checkQueue(`${INTAKE_QUEUE}.dead`)).messageCount).toBe(0);
    });

    it('Auth event (phone, canonical E.164) → SMS → Twilio → SENT; a non-canonical Auth phone is recorded FAILED invalid_destination and never sent', async () => {
      const ok = envelope({ userId: 'u-cert-2', channel: 'phone', destination: PHONE, code: OTP, expiresAt: future(600_000) });
      const local = envelope({ userId: 'u-cert-3', channel: 'phone', destination: '98765440', code: OTP, expiresAt: future(600_000) });
      await publisher.publish(ok);
      await publisher.publish(local);
      const okId = await intentFor(ok.headers.eventId);
      const localId = await intentFor(local.headers.eventId);
      await drain();
      expect((await deliveries(okId))[0]).toMatchObject({ channel: 'SMS', status: 'SENT', provider: 'twilio' });
      expect((await deliveries(localId))[0]).toMatchObject({ status: 'FAILED', failureCode: 'invalid_destination', destination: '98765440', attempts: 0 });
      expect(texts().map((r) => new URLSearchParams(r.body).get('To'))).toEqual([PHONE]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── locale and Unicode

  describe('locale resolution and Unicode through the adapters', () => {
    it('exact → base → default: fr-TN resolves fr (EMAIL, French accents byte-exact at Resend), ar resolves ar (SMS, Arabic byte-exact at Twilio), de falls back to en', async () => {
      const fr = await post(A.token, codeBody([{ channel: 'EMAIL', destination: EMAIL }], { locale: 'fr-TN' }));
      const ar = await post(A.token, codeBody([{ channel: 'SMS', destination: PHONE }], { locale: 'ar' }));
      const de = await post(A.token, codeBody([{ channel: 'EMAIL', destination: 'cert-de@example.test' }], { locale: 'de' }));
      await drain();
      expect((await deliveries(fr.body.id))[0]).toMatchObject({ locale: 'fr', status: 'SENT' });
      expect((await deliveries(ar.body.id))[0]).toMatchObject({ locale: 'ar', status: 'SENT' });
      expect((await deliveries(de.body.id))[0]).toMatchObject({ locale: 'en', status: 'SENT' });
      const frMail = JSON.parse(emails().find((r) => JSON.parse(r.body).to[0] === EMAIL)!.body);
      expect(frMail.subject).toBe(FR_SUBJECT);
      expect(frMail.text).toMatch(new RegExp(`^Votre code : ${OTP}\\. Il expire à .+\\. Ne le partagez jamais\\.$`));
      expect(new URLSearchParams(texts()[0].body).get('Body')).toBe(`رمز التحقق الخاص بك هو ${OTP}. لا تشاركه.`);
      expect(JSON.parse(emails().find((r) => JSON.parse(r.body).to[0] === 'cert-de@example.test')!.body).subject).toBe('Your verification code');
    });

    it('an Arabic SMS over its segment contract fails deterministically (content_too_long), is never truncated and never sent', async () => {
      const r = await post(A.token, { template: 'membership.approved', locale: 'ar', channels: [{ channel: 'SMS', destination: PHONE }] });
      await drain();
      expect((await deliveries(r.body.id))[0]).toMatchObject({ locale: 'ar', status: 'FAILED', failureCode: 'content_too_long', attempts: 0 });
      expect(texts()).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────── destination limiter (D21)

  describe('destination limiter in the integrated state', () => {
    it('one destination is one channel-specific bucket across callers and templates; over the limit → FAILED rate_limited; SMS has its own bucket', async () => {
      const ids = [
        (await post(A.token, codeBody([{ channel: 'EMAIL', destination: EMAIL }]))).body.id,
        (await post(B.token, { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] })).body.id,
        (await post(A.token, { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] })).body.id,
        (await post(B.token, { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] })).body.id,
      ];
      const smsId = (await post(A.token, { template: 'membership.approved', channels: [{ channel: 'SMS', destination: PHONE }] })).body.id;
      await drain();
      const st = await Promise.all(ids.map(async (id) => (await deliveries(id))[0]));
      expect(st.filter((d) => d.status === 'SENT')).toHaveLength(3);
      expect(st.filter((d) => d.status === 'FAILED' && d.failureCode === 'rate_limited')).toHaveLength(1);
      expect((await deliveries(smsId))[0].status).toBe('SENT');
      const keyOf = (c: string, d: string) => createHash('sha256').update(`notif_dest:${destinationIdentity(TEST_DESTINATION_LIMIT_KEY, c, d)}`).digest('hex');
      const rows = await sql<{ key: string; count: number }>(db.url, `SELECT key, count FROM kit_rate_limit WHERE bucket = 'notif_dest'`);
      expect(rows.find((r) => r.key === keyOf('EMAIL', EMAIL))?.count).toBe(4);
      expect(rows.find((r) => r.key === keyOf('SMS', PHONE))?.count).toBe(1);
      expect(keyOf('EMAIL', EMAIL)).not.toBe(keyOf('SMS', EMAIL));
      for (const plain of [EMAIL, PHONE, `EMAIL|${EMAIL}`, `SMS|${PHONE}`]) {
        expect(rows.map((r) => r.key)).not.toContain(createHash('sha256').update(`notif_dest:${plain}`).digest('hex'));
        expect(rows.map((r) => r.key)).not.toContain(createHash('sha256').update(plain).digest('hex'));
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────── lease fencing

  describe('lease fencing across instances', () => {
    it('a stale worker whose claim was recovered and RE-CLAIMED by another instance (SENDING again) can neither start an attempt nor call the provider', async () => {
      const other = await start();
      extra.push(other);
      const nid = (await post(A.token, { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: 'cert-fence@example.test' }] })).body.id;
      const [stale] = await worker().claim(); // instance A claims, then stalls (GC pause, partition) before starting its attempt
      await sql(db.url, `UPDATE notification_delivery SET "leaseUntil" = now() - interval '1 second' WHERE id = $1`, [stale.id]);
      const blank = { recovered: 0, claimed: 0, sent: 0, retried: 0, failed: 0, unconfirmed: 0, resent: 0, expired: 0, cancelled: 0 };
      await worker(other).recoverStale(blank); // no attempt → PENDING
      const [fresh] = await worker(other).claim(); // instance B now owns it: SENDING under B's lease token
      expect(fresh.id).toBe(stale.id);
      await expect(worker().processOne(stale, { ...blank })).rejects.toThrow('lease_lost'); // A resumes with its old token
      expect(emails()).toHaveLength(0);
      expect(await attempts(stale.id)).toEqual([]);
      await worker(other).processOne(fresh, { ...blank });
      expect((await deliveries(nid))[0]).toMatchObject({ status: 'SENT', attempts: 1 });
      expect(emails()).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────── restart, authority, final leak scan

  describe('restart and authority', () => {
    it('restart with pending, scheduled and retrying work: nothing lost, nothing duplicated, each resumes at its time', async () => {
      stub.behaviour = (req) => (req.path === '/emails'
        ? { kind: 'json', status: 503, body: { name: 'service_unavailable', message: `upstream error for ${PII}` } }
        : { kind: 'json', status: 201, body: { sid: SID(++n) } });
      const retrying = (await post(A.token, { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: 'cert-retry@example.test' }] })).body.id;
      await drain();
      expect((await deliveries(retrying))[0]).toMatchObject({ status: 'PENDING', failureCode: 'provider_unavailable', attempts: 1 });
      const pending = (await post(A.token, { template: 'membership.approved', channels: [{ channel: 'SMS', destination: '+21698765441' }] })).body.id;
      const scheduled = (await post(A.token, { template: 'membership.approved', scheduledAt: future(2500), channels: [{ channel: 'SMS', destination: '+21698765442' }] })).body.id;
      const intents = (await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM notification`))[0].n;
      // the instance "dies": a new one starts on the same database and broker
      const next = await start();
      extra.push(next);
      accept();
      await drain(next);
      expect((await deliveries(pending))[0].status).toBe('SENT');
      expect((await deliveries(scheduled))[0].status).toBe('PENDING'); // not before its time
      expect((await deliveries(retrying))[0].status).toBe('PENDING'); // not before its backoff
      await new Promise((r) => setTimeout(r, 2600));
      await sql(db.url, `UPDATE notification_delivery SET "nextAttemptAt" = now() WHERE "notificationId" = $1`, [retrying]);
      await drain(next);
      expect((await deliveries(scheduled))[0]).toMatchObject({ status: 'SENT', attempts: 1 });
      expect((await deliveries(retrying))[0]).toMatchObject({ status: 'SENT', attempts: 2 });
      expect((await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM notification`))[0].n).toBe(intents);
      const dup = await sql(db.url, `SELECT "deliveryId" FROM notification_delivery_attempt GROUP BY "deliveryId", "attemptNumber" HAVING count(*) > 1`);
      expect(dup).toEqual([]);
    });

    it('callers cannot choose a sender, provider, template body, version or owner scope; policy and caller isolation hold', async () => {
      const base = { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] };
      for (const [field, value] of [['from', 'x@evil.test'], ['sender', 'EVIL'], ['provider', 'test'], ['messagingServiceSid', `MG${'9'.repeat(32)}`],
        ['body', 'raw content'], ['bodyText', 'raw'], ['subject', 'x'], ['templateVersion', 2], ['version', 2], ['ownerScope', 'organization']] as const) {
        const r = await post(A.token, { ...base, [field]: value });
        expect(r.status, field).toBe(400);
      }
      expect((await post(B.token, codeBody([{ channel: 'EMAIL', destination: EMAIL }]))).status).toBe(403); // template not in B's policy
      expect((await post(B.token, { ...base, channels: [{ channel: 'SMS', destination: PHONE }] })).status).toBe(403); // channel
      expect((await post(B.token, { ...base, organizationId: randomUUID() })).status).toBe(403); // organization mode none
      const mine = (await post(A.token, base)).body.id;
      const g = await request(t.app.getHttpServer()).get(`/notification/notifications/${mine}`).set('authorization', `Bearer ${B.token}`);
      const c = await request(t.app.getHttpServer()).post(`/notification/notifications/${mine}/cancel`).set('authorization', `Bearer ${B.token}`);
      expect([g.status, c.status]).toEqual([404, 404]);
      const spoof = await request(t.app.getHttpServer()).get(`/notification/notifications/${mine}`).set('authorization', `Bearer ${B.token}`).set('x-caller', 'cert-caller-a');
      expect(spoof.status).toBe(404);
      expect((await deliveries(mine))[0].status).toBe('PENDING'); // untouched by B
    });
  });

  it('final integrated leak scan: no code, destination, rendered content, key, credential, token or provider text in any log or outside the intended columns', async () => {
    // provider error bodies carrying personal data, and a Twilio rejection naming the number
    stub.behaviour = (req) => (req.path === '/emails'
      ? { kind: 'json', status: 422, body: { name: 'validation_error', message: `invalid to ${EMAIL} ${PII}` } }
      : { kind: 'json', status: 400, body: { code: 21211, message: `The 'To' number ${PHONE} is not valid ${PII}` } });
    await post(A.token, codeBody([{ channel: 'EMAIL', destination: EMAIL }, { channel: 'SMS', destination: PHONE }]));
    await drain();
    await t.app.get(OpsReporter).report();
    const sentinels = [OTP, EMAIL, PHONE, PII, RESEND_KEY, TW_SECRET, `SK${'2'.repeat(32)}`, A.token, B.token, TEST_SECRET_KEYS.split(':')[1],
      TEST_REQUEST_HASH_KEY.toString('base64'), TEST_DESTINATION_LIMIT_KEY.toString('base64'), 'رمز التحقق', 'Votre code'];
    const all = logs();
    for (const s of sentinels) expect(all.includes(s), `log leak #${sentinels.indexOf(s)}`).toBe(false);
    const tables = await sql<{ t: string }>(db.url, `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`);
    for (const { t: table } of tables) {
      const dump = JSON.stringify(await sql(db.url, `SELECT row_to_json(x) AS r FROM "${table}" x`));
      // the frozen destination snapshot (notification_delivery.destination) is the only place a destination may live; rendered
      // template text lives only in the template versions
      const allowed: Record<string, string[]> = { notification_delivery: [EMAIL, PHONE], notification_template_version: ['رمز التحقق', 'Votre code'] };
      for (const s of sentinels.filter((x) => !(allowed[table] ?? []).includes(x))) expect(dump.includes(s), `${table} holds sentinel #${sentinels.indexOf(s)}`).toBe(false);
    }
  });
});

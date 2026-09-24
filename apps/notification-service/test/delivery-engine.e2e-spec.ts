import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { DeliveryWorker, type PassResult } from '../src/delivery/delivery-worker.js';
import type { ChannelProvider, ProviderRegistry, ProviderResult } from '../src/delivery/provider.js';
import type { RenderedMessage } from '../src/delivery/renderer.js';
import { SecretPurgeWorker } from '../src/delivery/secret-purge.worker.js';
import { TEST_REQUEST_HASH_KEY, TEST_SECRET_KEYS, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 16.7: the delivery engine on a real PostgreSQL with the real application module (SDD §8, §5, §9.3, §12.1, §13). The providers
 * are in-test fakes with controlled outcomes (the engine sees only the port); the loops are stopped and every pass is driven explicitly,
 * except where a test is about the loop itself (resilience, shutdown).
 */
const A = generateServiceToken();
const TOKENS = [{ caller: 'core-caller-a', digest: A.digest }];
const OTP = '740263'; // sentinel one-time code
const EMAIL = 'engine-leak-probe@example.test';
const PHONE = '+21698765432';
const LEASE_MS = 5000;
const TIMEOUT_MS = 300;
const BASE_ENV = {
  NOTIFICATION_WORKER_INTERVAL_MS: '60000', NOTIFICATION_LEASE_MS: String(LEASE_MS), NOTIFICATION_PROVIDER_TIMEOUT_MS: String(TIMEOUT_MS),
  NOTIFICATION_RETRY_BASE_MS: '1000', NOTIFICATION_RETRY_CEILING_MS: '4000', NOTIFICATION_MAX_ATTEMPTS: '3', NOTIFICATION_WORKER_CONCURRENCY: '3',
  NOTIFICATION_WORKER_BATCH_SIZE: '20', DB_POOL_MAX: '10',
  NOTIFICATION_RATE_DESTINATION_LIMIT: '100000', // these tests reuse one destination; the limiter has its own suite
};
const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Behavior = (m: RenderedMessage, ctx: { reference: string; attemptId: string }) => Promise<ProviderResult> | ProviderResult;
const accept: Behavior = (_m, ctx) => ({ kind: 'accepted', providerMessageId: `fake-${ctx.attemptId}` });

/** A controllable provider: records every call (in test memory only) and the maximum simultaneous calls. */
class FakeProvider implements ChannelProvider {
  readonly id = 'fake';
  readonly capabilities = { idempotencyKey: true };
  calls: { reference: string; attemptId: string; message: RenderedMessage; at: number }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  behavior: Behavior = accept;
  constructor(readonly channel: 'EMAIL' | 'SMS') {}
  async send(message: RenderedMessage, ctx: { reference: string; attemptId: string }): Promise<ProviderResult> {
    this.calls.push({ ...ctx, message, at: Date.now() });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await this.behavior(message, ctx);
    } finally {
      this.inFlight--;
    }
  }
  reset(): void {
    this.calls = [];
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.behavior = accept;
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describeWithEnv('notification delivery engine (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let worker: DeliveryWorker;
  let purge: SecretPurgeWorker;
  const email = new FakeProvider('EMAIL');
  const sms = new FakeProvider('SMS');
  const extra: TestApp[] = [];
  /** Nest's static Logger follows the LAST application created, so log assertions search every application's lines. */
  const every: TestApp[] = [];
  const allLogs = () => every.flatMap((x) => x.logs);
  const calls = () => email.calls.length + sms.calls.length;

  const app = async (over: Record<string, string> = {}, providers: ProviderRegistry = { EMAIL: email, SMS: sms }, keep = false) => {
    const a = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, env: { ...BASE_ENV, ...over }, providers });
    if (!keep) {
      await a.app.get(DeliveryWorker).stopPolling();
      await a.app.get(SecretPurgeWorker).stopPolling();
    }
    extra.push(a);
    every.push(a);
    return a;
  };
  const send = async (body: Record<string, unknown>, target = t): Promise<string> => {
    const r = await request(target.app.getHttpServer()).post('/notification/notifications').set('authorization', `Bearer ${A.token}`).set('idempotency-key', `k-${randomUUID()}`).send(body);
    if (r.status !== 202) throw new Error(`send refused: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const code = (over: Record<string, unknown> = {}, channels = [{ channel: 'SMS', destination: PHONE }, { channel: 'EMAIL', destination: EMAIL }]) =>
    send({ template: 'identity.contact_verification_code', recipient: { type: 'user', id: 'u-engine' }, channels, data: { code: OTP, expiresAt: future(600_000) }, expiresAt: future(600_000), ...over });
  const alert = (over: Record<string, unknown> = {}, channels: { channel: string; destination: string }[] = [{ channel: 'EMAIL', destination: EMAIL }], target = t) =>
    send({ template: 'membership.approved', channels, ...over }, target);
  const deliveries = (nid: string) => sql<Record<string, any>>(db.url, `SELECT * FROM notification_delivery WHERE "notificationId" = $1 ORDER BY channel`, [nid]);
  const one = async (nid: string, channel = 'EMAIL') => (await deliveries(nid)).find((d) => d.channel === channel)!;
  const attempts = (did: string) => sql<Record<string, any>>(db.url, `SELECT * FROM notification_delivery_attempt WHERE "deliveryId" = $1 ORDER BY "attemptNumber"`, [did]);
  const secret = async (nid: string) => (await sql<{ c: Buffer | null; k: string | null }>(db.url, `SELECT "secretCiphertext" AS c, "secretKeyId" AS k FROM notification WHERE id = $1`, [nid]))[0];
  const expireLease = (did: string) => sql(db.url, `UPDATE notification_delivery SET "leaseUntil" = now() - interval '1 second' WHERE id = $1 AND status = 'SENDING'`, [did]);
  const makeDue = (did: string) => sql(db.url, `UPDATE notification_delivery SET "nextAttemptAt" = now() WHERE id = $1 AND status = 'PENDING'`, [did]);
  const drain = async (w = worker, max = 10) => {
    const total: PassResult[] = [];
    for (let i = 0; i < max; i++) {
      const r = await w.passOnce();
      total.push(r);
      if (r.claimed === 0 && r.recovered === 0) break;
    }
    return total;
  };
  /** Only the rows of `ids` are claimable: everything else due is parked, so tests never process each other's leftovers. */
  const quiesce = async () => {
    await sql(db.url, `UPDATE notification_delivery SET status = 'CANCELLED', "nextAttemptAt" = NULL, "completedAt" = now() WHERE status = 'PENDING'`);
    await sql(db.url, `UPDATE notification_delivery SET status = 'FAILED', "leaseUntil" = NULL, "failedAt" = now(), "completedAt" = now(), "failureCode" = 'test_cleanup' WHERE status = 'SENDING'`);
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifengine');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, env: BASE_ENV, providers: { EMAIL: email, SMS: sms } });
    every.push(t);
    worker = t.app.get(DeliveryWorker);
    purge = t.app.get(SecretPurgeWorker);
    await worker.stopPolling();
    await purge.stopPolling();
  });
  beforeEach(async () => {
    email.reset();
    sms.reset();
    await quiesce();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const a of extra.splice(0)) await a.app.close();
  });
  afterAll(async () => {
    await t?.app.close();
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${new URL(db.url).pathname.slice(1)}" WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
    await db.drop();
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────── outcomes

  describe('outcomes', () => {
    it('accepted: SENDING → SENT on every channel, attempt ACCEPTED with the provider id, the pinned version rendered, the secret purged', async () => {
      const nid = await code();
      const [r] = await drain();
      expect(r).toMatchObject({ claimed: 2, sent: 2 });
      for (const d of await deliveries(nid)) {
        expect(d).toMatchObject({ status: 'SENT', attempts: 1, provider: 'fake', failureClass: null, failureCode: null, leaseUntil: null, nextAttemptAt: null });
        expect(d.sentAt).toBeInstanceOf(Date);
        expect(d.completedAt).toBeInstanceOf(Date);
        const [a] = await attempts(d.id);
        expect(a).toMatchObject({ attemptNumber: 1, outcome: 'ACCEPTED', provider: 'fake', failureCode: null });
        expect(d.providerMessageId).toBe(`fake-${a.id}`);
        expect(a.providerMessageId).toBe(d.providerMessageId);
        expect(a.latencyMs).toBeGreaterThanOrEqual(0);
      }
      expect(sms.calls[0].message).toMatchObject({ channel: 'SMS', destination: PHONE, subject: undefined });
      expect(sms.calls[0].message.text).toMatch(new RegExp(`^Your verification code is ${OTP}\\. It expires at .+ Never share it\\.$`));
      expect(email.calls[0].message).toMatchObject({ channel: 'EMAIL', destination: EMAIL, subject: 'Your verification code' });
      expect(email.calls[0].reference).toBe((await one(nid)).id); // the delivery id is the provider reference
      expect(await secret(nid)).toEqual({ c: null, k: null });
    });

    it('retryable: attempt RETRYABLE_FAILURE, SENDING → PENDING with a backoff due time; the secret is kept; the next due pass sends', async () => {
      const nid = await code({}, [{ channel: 'SMS', destination: PHONE }]);
      sms.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: 'fake_unavailable' });
      const before = Date.now();
      expect((await worker.passOnce()).retried).toBe(1);
      let d = await one(nid, 'SMS');
      expect(d).toMatchObject({ status: 'PENDING', attempts: 1, failureClass: 'retryable', failureCode: 'fake_unavailable', leaseUntil: null });
      const delay = d.nextAttemptAt.getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(800 - 50); // base 1000, -20 %
      expect(delay).toBeLessThanOrEqual(1200 + 500);
      expect((await attempts(d.id)).map((a) => [a.attemptNumber, a.outcome, a.failureCode])).toEqual([[1, 'RETRYABLE_FAILURE', 'fake_unavailable']]);
      expect((await secret(nid)).c).not.toBeNull(); // still needed by the retry

      expect((await worker.passOnce()).claimed).toBe(0); // not due yet: no hot spin
      sms.behavior = accept;
      await makeDue(d.id);
      expect((await worker.passOnce()).sent).toBe(1);
      d = await one(nid, 'SMS');
      expect(d).toMatchObject({ status: 'SENT', attempts: 2, failureClass: null, failureCode: null });
      expect((await attempts(d.id)).map((a) => a.outcome)).toEqual(['RETRYABLE_FAILURE', 'ACCEPTED']);
      expect(sms.calls.map((c) => c.message.text.includes(OTP))).toEqual([true, true]); // the same code both times
      expect(await secret(nid)).toEqual({ c: null, k: null });
    });

    it('a Retry-After hint raises the delay (bounded by the ceiling)', async () => {
      const nid = await alert({}, [{ channel: 'SMS', destination: PHONE }]);
      sms.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: 'fake_rate_limited', retryAfterMs: 3000 });
      const before = Date.now();
      await worker.passOnce();
      const d = await one(nid, 'SMS');
      expect(d.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(3000 - 50);
      expect(d.nextAttemptAt.getTime() - before).toBeLessThanOrEqual(4000 + 500);
    });

    it('retries exhausted: after NOTIFICATION_MAX_ATTEMPTS (3) retryable failures → FAILED retries_exhausted; attempts are history', async () => {
      const nid = await code({}, [{ channel: 'EMAIL', destination: EMAIL }]);
      email.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: 'fake_unavailable' });
      const d0 = await one(nid);
      for (let i = 0; i < 3; i++) {
        await makeDue(d0.id);
        await worker.passOnce();
      }
      const d = await one(nid);
      expect(d).toMatchObject({ status: 'FAILED', attempts: 3, failureClass: 'retryable', failureCode: 'retries_exhausted' });
      expect(d.failedAt).toBeInstanceOf(Date);
      expect((await attempts(d.id)).map((a) => [a.attemptNumber, a.outcome])).toEqual([[1, 'RETRYABLE_FAILURE'], [2, 'RETRYABLE_FAILURE'], [3, 'RETRYABLE_FAILURE']]);
      expect(email.calls).toHaveLength(3);
      await drain();
      expect(email.calls).toHaveLength(3); // never again
      expect(await secret(nid)).toEqual({ c: null, k: null });
    });

    it('terminal: attempt TERMINAL_FAILURE, SENDING → FAILED with the bounded code; an unbounded provider code becomes a fixed one', async () => {
      const nid = await alert({}, [{ channel: 'EMAIL', destination: EMAIL }, { channel: 'SMS', destination: PHONE }]);
      email.behavior = () => ({ kind: 'rejected', failureClass: 'terminal', code: 'fake_rejected' });
      sms.behavior = () => ({ kind: 'rejected', failureClass: 'terminal', code: `Invalid 'To' number ${PHONE}` });
      await worker.passOnce();
      const [e, s] = await deliveries(nid);
      expect(e).toMatchObject({ status: 'FAILED', failureClass: 'terminal', failureCode: 'fake_rejected', attempts: 1 });
      expect(s).toMatchObject({ status: 'FAILED', failureClass: 'terminal', failureCode: 'provider_rejected' });
      expect((await attempts(s.id))[0]).toMatchObject({ outcome: 'TERMINAL_FAILURE', failureCode: 'provider_rejected' });
      await drain();
      expect(calls()).toBe(2);
    });

    it('provider_auth_fault (our credentials refused) stays retryable and is logged as an error', async () => {
      const nid = await alert();
      email.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: 'provider_auth_fault' });
      await worker.passOnce();
      expect(await one(nid)).toMatchObject({ status: 'PENDING', failureCode: 'provider_auth_fault' });
      expect(allLogs().some((l) => String(l.msg).startsWith('provider_auth_fault') && l.level === 'error')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────── ambiguity

  describe('ambiguity (SDD §8.5, frozen)', () => {
    it('a notification without a secret: attempt AMBIGUOUS → UNCONFIRMED (terminal), never resent', async () => {
      const nid = await alert();
      email.behavior = () => ({ kind: 'ambiguous', code: 'fake_ambiguous' });
      expect((await worker.passOnce()).unconfirmed).toBe(1);
      const d = await one(nid);
      expect(d).toMatchObject({ status: 'UNCONFIRMED', failureClass: 'ambiguous', failureCode: 'fake_ambiguous', ambiguousResends: 0, attempts: 1 });
      expect(d.completedAt).toBeInstanceOf(Date);
      expect((await attempts(d.id))[0]).toMatchObject({ outcome: 'AMBIGUOUS', failureCode: 'fake_ambiguous' });
      email.behavior = accept;
      await drain();
      expect(email.calls).toHaveLength(1);
    });

    it('a one-time code: ONE resend with the same code, version and reference; a second ambiguity ends UNCONFIRMED', async () => {
      const nid = await code({}, [{ channel: 'SMS', destination: PHONE }]);
      sms.behavior = () => ({ kind: 'ambiguous', code: 'fake_ambiguous' });
      const first = await worker.passOnce();
      expect(first).toMatchObject({ resent: 1, unconfirmed: 0 });
      let d = await one(nid, 'SMS');
      expect(d).toMatchObject({ status: 'PENDING', ambiguousResends: 1, failureClass: 'ambiguous', attempts: 1 });
      expect(d.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await secret(nid)).c).not.toBeNull(); // the resend needs it
      await worker.passOnce();
      d = await one(nid, 'SMS');
      expect(d).toMatchObject({ status: 'UNCONFIRMED', ambiguousResends: 1, attempts: 2 });
      expect(sms.calls).toHaveLength(2);
      expect(sms.calls[0].message).toEqual(sms.calls[1].message); // same code, same version: the same bytes
      expect(sms.calls[0].reference).toBe(sms.calls[1].reference);
      expect(await secret(nid)).toEqual({ c: null, k: null });
      await drain();
      expect(sms.calls).toHaveLength(2);
    });

    it('a one-time code resent after ambiguity that is then accepted ends SENT', async () => {
      const nid = await code({}, [{ channel: 'EMAIL', destination: EMAIL }]);
      let n = 0;
      email.behavior = (_m, ctx) => (n++ === 0 ? { kind: 'ambiguous', code: 'fake_ambiguous' } : accept(_m, ctx));
      await drain();
      expect(await one(nid)).toMatchObject({ status: 'SENT', ambiguousResends: 1, attempts: 2 });
      expect((await attempts((await one(nid)).id)).map((a) => a.outcome)).toEqual(['AMBIGUOUS', 'ACCEPTED']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────── provider timeout

  describe('provider timeout and provider errors: bounded, ambiguous, the worker continues', () => {
    it('a hanging provider is cut at NOTIFICATION_PROVIDER_TIMEOUT_MS: AMBIGUOUS provider_timeout; the other deliveries of the pass are sent', async () => {
      const hang = await alert({}, [{ channel: 'EMAIL', destination: EMAIL }]);
      const ok = await alert({}, [{ channel: 'SMS', destination: PHONE }]);
      email.behavior = () => new Promise<ProviderResult>(() => undefined);
      const t0 = Date.now();
      const r = await worker.passOnce();
      expect(Date.now() - t0).toBeLessThan(TIMEOUT_MS + 1500);
      expect(r).toMatchObject({ claimed: 2, sent: 1, unconfirmed: 1 });
      expect(await one(hang)).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'provider_timeout' });
      expect((await attempts((await one(hang)).id))[0]).toMatchObject({ outcome: 'AMBIGUOUS', failureCode: 'provider_timeout' });
      expect((await attempts((await one(hang)).id))[0].latencyMs).toBeGreaterThanOrEqual(TIMEOUT_MS - 5);
      expect(await one(ok, 'SMS')).toMatchObject({ status: 'SENT' });
    });

    it('a quick provider is not delayed by the bound', async () => {
      await alert();
      const t0 = Date.now();
      await worker.passOnce();
      expect(Date.now() - t0).toBeLessThan(TIMEOUT_MS);
    });

    it.each([
      ['throws synchronously', (): ProviderResult => { throw new Error(`provider-exc-5521 ${PHONE} ${OTP}`); }],
      ['rejects asynchronously', async (): Promise<ProviderResult> => { throw new TypeError(`provider-exc-5521 ${EMAIL}`); }],
      ['resolves garbage', async () => ({ kind: 'weird' }) as unknown as ProviderResult],
    ])('a provider that %s is AMBIGUOUS provider_error (never retried blindly); nothing of its message is logged', async (_l, fn) => {
      const nid = await alert();
      if (_l === 'throws synchronously') {
        // a raw port implementation whose send is not async: the engine must still contain the throw
        const raw: ChannelProvider = { id: 'raw', channel: 'EMAIL', capabilities: { idempotencyKey: false }, send: fn as never };
        const a = await app({}, { EMAIL: raw });
        await a.app.get(DeliveryWorker).passOnce();
        expect(await one(nid)).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'provider_error' });
        const leaked = allLogs().filter((l) => new RegExp(`${OTP}|\\${PHONE}|provider-exc-5521`).test(JSON.stringify(l)));
        expect(leaked, JSON.stringify(leaked).slice(0, 600)).toEqual([]);
        return;
      }
      email.behavior = fn as Behavior;
      await worker.passOnce();
      const d = await one(nid);
      expect(d.status).toBe('UNCONFIRMED');
      expect(['provider_error', 'provider_invalid_result']).toContain(d.failureCode);
      const leaked = allLogs().filter((l) => new RegExp(`${EMAIL}|provider-exc-5521`).test(JSON.stringify(l)));
      expect(leaked, JSON.stringify(leaked).slice(0, 600)).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────── cancel and expiry

  describe('cancellation race (SDD §9.3) and expiry', () => {
    it('C2: claimed, then cancelled through the API (409, in progress), then the pre-send check → CANCELLED, provider calls 0, no attempt', async () => {
      const nid = await code();
      const claims = await worker.claim();
      expect(claims).toHaveLength(2);
      const r = await request(t.app.getHttpServer()).post(`/notification/notifications/${nid}/cancel`).set('authorization', `Bearer ${A.token}`);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('delivery_in_progress');
      const pass: PassResult = { recovered: 0, claimed: 0, sent: 0, retried: 0, failed: 0, unconfirmed: 0, resent: 0, expired: 0, cancelled: 0 };
      for (const c of claims) await worker.processOne(c, pass);
      expect(pass.cancelled).toBe(2);
      expect(calls()).toBe(0);
      for (const d of await deliveries(nid)) {
        expect(d).toMatchObject({ status: 'CANCELLED', attempts: 0, leaseUntil: null, nextAttemptAt: null });
        expect(await attempts(d.id)).toEqual([]);
      }
      expect(await secret(nid)).toEqual({ c: null, k: null });
      const view = await request(t.app.getHttpServer()).get(`/notification/notifications/${nid}`).set('authorization', `Bearer ${A.token}`);
      expect(view.body.status).toBe('CANCELLED');
    });

    it('a PENDING delivery cancelled before the claim is never claimed', async () => {
      const nid = await alert();
      expect((await request(t.app.getHttpServer()).post(`/notification/notifications/${nid}/cancel`).set('authorization', `Bearer ${A.token}`)).status).toBe(200);
      expect((await worker.passOnce()).claimed).toBe(0);
      expect(calls()).toBe(0);
    });

    it('already expired before the claim → EXPIRED at the pre-send check, provider calls 0, secret purged', async () => {
      const nid = await code({ expiresAt: future(700), data: { code: OTP, expiresAt: future(700) } }, [{ channel: 'SMS', destination: PHONE }]);
      await sleep(800);
      expect((await worker.passOnce()).expired).toBe(1);
      expect(await one(nid, 'SMS')).toMatchObject({ status: 'EXPIRED', attempts: 0 });
      expect(calls()).toBe(0);
      expect(await secret(nid)).toEqual({ c: null, k: null });
    });

    it('C3: expires between the claim and the send → EXPIRED, provider calls 0', async () => {
      const nid = await code({ expiresAt: future(700), data: { code: OTP, expiresAt: future(700) } }, [{ channel: 'SMS', destination: PHONE }]);
      const claims = await worker.claim();
      expect(claims).toHaveLength(1);
      await sleep(800);
      const pass = { recovered: 0, claimed: 0, sent: 0, retried: 0, failed: 0, unconfirmed: 0, resent: 0, expired: 0, cancelled: 0 };
      await worker.processOne(claims[0], pass);
      expect(pass.expired).toBe(1);
      expect(calls()).toBe(0);
      expect(await one(nid, 'SMS')).toMatchObject({ status: 'EXPIRED', attempts: 0 });
    });

    it('expires while waiting for a retry → EXPIRED when due, never sent after expiry', async () => {
      const nid = await code({ expiresAt: future(2500), data: { code: OTP, expiresAt: future(2500) } }, [{ channel: 'SMS', destination: PHONE }]);
      sms.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: 'fake_unavailable' });
      await worker.passOnce();
      expect(await one(nid, 'SMS')).toMatchObject({ status: 'PENDING' });
      sms.behavior = accept;
      await sleep(2600);
      await makeDue((await one(nid, 'SMS')).id);
      await worker.passOnce();
      expect(await one(nid, 'SMS')).toMatchObject({ status: 'EXPIRED', attempts: 1 });
      expect(sms.calls).toHaveLength(1);
    });

    it('a retry that would fall at or after expiresAt ends EXPIRED at once (no pointless wait)', async () => {
      const nid = await code({ expiresAt: future(1500), data: { code: OTP, expiresAt: future(1500) } }, [{ channel: 'SMS', destination: PHONE }]);
      sms.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: 'fake_rate_limited', retryAfterMs: 3000 });
      expect((await worker.passOnce()).expired).toBe(1);
      expect(await one(nid, 'SMS')).toMatchObject({ status: 'EXPIRED', failureClass: 'retryable', failureCode: 'fake_rate_limited' });
      expect(await secret(nid)).toEqual({ c: null, k: null });
    });

    it('a future scheduledAt is not due before its time', async () => {
      const nid = await alert({ scheduledAt: future(1200) });
      expect((await worker.passOnce()).claimed).toBe(0);
      await sleep(1300);
      expect((await worker.passOnce()).sent).toBe(1);
      expect(await one(nid)).toMatchObject({ status: 'SENT' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── crash windows and stale leases

  describe('crash windows A–F and stale-lease recovery by durable evidence (SDD §5.3, §13)', () => {
    const blank = (): PassResult => ({ recovered: 0, claimed: 0, sent: 0, retried: 0, failed: 0, unconfirmed: 0, resent: 0, expired: 0, cancelled: 0 });

    it('A: claimed, crash before the attempt → no attempt = no call possible → PENDING, sent once', async () => {
      const nid = await alert();
      await worker.claim(); // the "crashed" worker: SENDING under a lease, nothing more
      const d = await one(nid);
      expect(d).toMatchObject({ status: 'SENDING', attempts: 0 });
      expect((await worker.passOnce()).recovered).toBe(0); // a live lease is never taken
      await expireLease(d.id);
      const [r] = await drain();
      expect(r).toMatchObject({ recovered: 1, sent: 1 });
      expect(await one(nid)).toMatchObject({ status: 'SENT', attempts: 1, ambiguousResends: 0 });
      expect(email.calls).toHaveLength(1);
      const lines = allLogs().filter((l) => String(l.msg).includes('lease_recovered'));
      expect(lines.some((l) => String(l.msg).includes(`deliveryId=${d.id} evidence=no_attempt outcome=PENDING`)), JSON.stringify(lines).slice(0, 500)).toBe(true);
    });

    it('B: attempt STARTED committed, crash before the call → cannot prove no call → AMBIGUOUS worker_lost; an alert ends UNCONFIRMED', async () => {
      const nid = await alert();
      const [c] = await worker.claim();
      await worker.startAttempt(c, email);
      await expireLease(c.id);
      await drain();
      const d = await one(nid);
      expect(d).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'worker_lost', attempts: 1 });
      expect((await attempts(d.id))[0]).toMatchObject({ outcome: 'AMBIGUOUS', failureCode: 'worker_lost' });
      expect(email.calls).toHaveLength(0);
    });

    it('B (a code): the same evidence → one resend of the same code', async () => {
      const nid = await code({}, [{ channel: 'SMS', destination: PHONE }]);
      const [c] = await worker.claim();
      await worker.startAttempt(c, sms);
      await expireLease(c.id);
      await drain();
      const d = await one(nid, 'SMS');
      expect(d).toMatchObject({ status: 'SENT', ambiguousResends: 1, attempts: 2 });
      expect((await attempts(d.id)).map((a) => [a.attemptNumber, a.outcome, a.failureCode])).toEqual([[1, 'AMBIGUOUS', 'worker_lost'], [2, 'ACCEPTED', null]]);
      expect(sms.calls).toHaveLength(1);
    });

    it('C: provider not called, the process dies (database lost before the attempt) → rows untouched → PENDING, sent once', async () => {
      const nid = await alert();
      const [c] = await worker.claim();
      vi.spyOn(worker, 'startAttempt').mockRejectedValueOnce(Object.assign(new Error('Connection terminated unexpectedly'), {}));
      await expect(worker.processOne(c, blank())).rejects.toThrow();
      expect(email.calls).toHaveLength(0);
      const d = await one(nid);
      expect(d).toMatchObject({ status: 'SENDING', attempts: 0 });
      expect(await attempts(d.id)).toEqual([]);
      await expireLease(d.id);
      await drain();
      expect(await one(nid)).toMatchObject({ status: 'SENT', attempts: 1 });
      expect(email.calls).toHaveLength(1);
    });

    it('D: provider accepted, the process dies before the outcome is recorded → AMBIGUOUS worker_lost; an alert is NOT resent', async () => {
      const nid = await alert();
      vi.spyOn(worker as any, 'finish').mockRejectedValueOnce(new Error('killed'));
      await worker.passOnce(); // the pass catches the failure: the rows stay as they were
      let d = await one(nid);
      expect(d).toMatchObject({ status: 'SENDING', attempts: 1 });
      expect((await attempts(d.id))[0].outcome).toBe('STARTED');
      await expireLease(d.id);
      await drain();
      d = await one(nid);
      expect(d).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'worker_lost' });
      expect(email.calls).toHaveLength(1); // exactly the one (accepted) call: no blind resend
    });

    it('D (a code): the one frozen resend — two messages with the same code is the documented worst case', async () => {
      const nid = await code({}, [{ channel: 'SMS', destination: PHONE }]);
      vi.spyOn(worker as any, 'finish').mockRejectedValueOnce(new Error('killed'));
      await worker.passOnce();
      await expireLease((await one(nid, 'SMS')).id);
      await drain();
      expect(await one(nid, 'SMS')).toMatchObject({ status: 'SENT', ambiguousResends: 1, attempts: 2 });
      expect(sms.calls).toHaveLength(2);
      expect(sms.calls[0].message.text).toBe(sms.calls[1].message.text);
    });

    it('E: the attempt outcome and the delivery transition are ONE transaction: a failure between them rolls both back (→ window D)', async () => {
      const nid = await alert();
      const spy = vi.spyOn(worker as any, 'transition').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
      await worker.passOnce();
      expect(spy).toHaveBeenCalled();
      const d = await one(nid);
      expect(d).toMatchObject({ status: 'SENDING' });
      expect((await attempts(d.id))[0]).toMatchObject({ outcome: 'STARTED', completedAt: null }); // the ACCEPTED write was rolled back
      await expireLease(d.id);
      await drain();
      expect(await one(nid)).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'worker_lost' });
      expect(email.calls).toHaveLength(1);
    });

    it('F / C6: terminal deliveries are never reprocessed, however many workers poll', async () => {
      const ids = [await alert(), await code({}, [{ channel: 'SMS', destination: PHONE }])];
      await drain();
      const w2 = (await app()).app.get(DeliveryWorker);
      const w3 = (await app()).app.get(DeliveryWorker);
      const before = await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM notification_delivery_attempt`);
      for (let i = 0; i < 5; i++) await Promise.all([worker.passOnce(), w2.passOnce(), w3.passOnce()]);
      expect(await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM notification_delivery_attempt`)).toEqual(before);
      expect(calls()).toBe(2);
      for (const id of ids) for (const d of await deliveries(id)) expect(d.status).toBe('SENT');
    });

    it('a late result from a worker whose lease was recovered is refused (the attempt guard); the recorded evidence stands', async () => {
      const slow = await app({ NOTIFICATION_PROVIDER_TIMEOUT_MS: '2000' });
      const other = await app();
      const nid = await alert();
      const gate = deferred<ProviderResult>();
      const called = deferred<void>();
      email.behavior = () => {
        called.resolve();
        return gate.promise;
      };
      const w = slow.app.get(DeliveryWorker);
      const [c] = await w.claim();
      const running = w.processOne(c, blank());
      await called.promise; // the old worker is inside the provider call
      await expireLease(c.id); // ... and partitioned past its lease
      await other.app.get(DeliveryWorker).recoverStale(blank());
      expect(await one(nid)).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'worker_lost' });
      gate.resolve({ kind: 'accepted', providerMessageId: 'late-id' });
      await expect(running).rejects.toThrow('lease_lost');
      const d = await one(nid);
      expect(d).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'worker_lost', providerMessageId: null });
      expect((await attempts(d.id))[0]).toMatchObject({ outcome: 'AMBIGUOUS', failureCode: 'worker_lost', providerMessageId: null });
    });

    it('a late renewal or transition of a recovered claim changes nothing (the lease token guard)', async () => {
      const nid = await alert();
      const [c] = await worker.claim();
      await expireLease(c.id);
      await drain(); // recovered and sent by "another" pass
      expect(await one(nid)).toMatchObject({ status: 'SENT' });
      await expect(worker.processOne(c, blank())).rejects.toThrow(); // the stale claim: its token no longer matches
      expect(email.calls).toHaveLength(1);
      expect(await attempts((await one(nid)).id)).toHaveLength(1);
    });

    it('the queued claims keep their lease while earlier ones are sent (renewal every lease / 4): no competing recovery', async () => {
      const a = await app({ NOTIFICATION_PROVIDER_TIMEOUT_MS: '2000', NOTIFICATION_WORKER_CONCURRENCY: '1', NOTIFICATION_WORKER_BATCH_SIZE: '5' });
      const rival = (await app()).app.get(DeliveryWorker);
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(await alert());
      email.behavior = async (m, ctx) => {
        await sleep(1500);
        return accept(m, ctx);
      };
      const pass = a.app.get(DeliveryWorker).passOnce(); // 5 x 1.5 s = 7.5 s > the 5 s lease
      let recovered = 0;
      const end = Date.now() + 8500;
      let done = false;
      void pass.then(() => (done = true));
      while (!done && Date.now() < end) {
        recovered += await rival.recoverStale(blank());
        await sleep(250);
      }
      expect(await pass).toMatchObject({ claimed: 5, sent: 5 });
      expect(recovered).toBe(0);
      expect(email.calls).toHaveLength(5);
      expect(new Set(email.calls.map((c) => c.reference)).size).toBe(5);
    }, 20_000);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────── concurrency campaigns

  describe('concurrency', () => {
    it('C1: three workers on one backlog of 60: every delivery claimed and sent once, one attempt each', async () => {
      const w2 = (await app()).app.get(DeliveryWorker);
      const w3 = (await app()).app.get(DeliveryWorker);
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) ids.push(await alert({}, [{ channel: 'EMAIL', destination: EMAIL }, { channel: 'SMS', destination: PHONE }]));
      email.behavior = async (m, ctx) => {
        await sleep(5);
        return accept(m, ctx);
      };
      await Promise.all([drain(worker, 20), drain(w2, 20), drain(w3, 20)]);
      expect(calls()).toBe(60);
      expect(new Set([...email.calls, ...sms.calls].map((c) => c.reference)).size).toBe(60);
      const rows = await sql<{ status: string; attempts: number; n: number }>(db.url,
        `SELECT d.status, d.attempts, (SELECT count(*)::int FROM notification_delivery_attempt a WHERE a."deliveryId" = d.id) AS n
           FROM notification_delivery d WHERE d."notificationId" = ANY($1::uuid[])`, [ids]);
      expect(rows).toHaveLength(60);
      expect(rows.every((r) => r.status === 'SENT' && r.attempts === 1 && r.n === 1)).toBe(true);
    });

    it('no transaction is open while a provider call runs (the claim and the attempt are committed first)', async () => {
      const seen: { state: string; n: number }[][] = [];
      email.behavior = async (m, ctx) => {
        await sleep(30);
        seen.push(await sql<{ state: string; n: number }>(db.url,
          `SELECT state, count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'notification-service' AND datname = current_database() AND state LIKE 'idle in transaction%' GROUP BY state`));
        return accept(m, ctx);
      };
      await alert();
      await alert();
      await worker.passOnce();
      expect(seen).toHaveLength(2);
      expect(seen.flat()).toEqual([]);
    });

    it('SKIP LOCKED: a claim never waits for a row another worker is claiming; it takes the others', async () => {
      const locked = await alert();
      const free = await alert();
      const lockedId = (await one(locked)).id;
      const pg = await import('pg');
      const c = new pg.default.Client({ connectionString: db.url });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT id FROM notification_delivery WHERE id = $1 FOR UPDATE`, [lockedId]);
        const t0 = Date.now();
        const claims = await worker.claim();
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(claims.map((x) => x.id)).toEqual([(await one(free)).id]);
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
      await quiesce();
    });

    it('C4: a retry that becomes due while three workers poll gets exactly one new attempt', async () => {
      const w2 = (await app()).app.get(DeliveryWorker);
      const w3 = (await app()).app.get(DeliveryWorker);
      const nid = await alert();
      email.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: 'fake_unavailable' });
      await worker.passOnce();
      email.behavior = accept;
      await makeDue((await one(nid)).id);
      await Promise.all([worker.passOnce(), w2.passOnce(), w3.passOnce(), worker.passOnce(), w2.passOnce(), w3.passOnce()]);
      expect((await attempts((await one(nid)).id)).map((a) => a.attemptNumber)).toEqual([1, 2]);
      expect(email.calls).toHaveLength(2);
    });

    it('bounded concurrency: never more than NOTIFICATION_WORKER_CONCURRENCY provider calls at once; the pool stays bounded', async () => {
      for (let i = 0; i < 12; i++) await alert();
      email.behavior = async (m, ctx) => {
        await sleep(60);
        return accept(m, ctx);
      };
      let peakConnections = 0;
      const probe = setInterval(() => {
        void sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'notification-service' AND datname = current_database()`)
          .then(([r]) => (peakConnections = Math.max(peakConnections, r.n))).catch(() => undefined);
      }, 20);
      await worker.passOnce();
      clearInterval(probe);
      expect(email.maxInFlight).toBe(3);
      expect(email.calls).toHaveLength(12);
      expect(peakConnections).toBeLessThanOrEqual(10 * (1 + extra.length)); // each app's pool is DB_POOL_MAX = 10
    });

    it('fairness: deliveries are served oldest-due first across channels; a later backlog in one channel does not starve an earlier other', async () => {
      const a = await app({ NOTIFICATION_WORKER_BATCH_SIZE: '10' });
      for (let i = 0; i < 15; i++) await alert({}, [{ channel: 'EMAIL', destination: EMAIL }]);
      const smsIds = [];
      for (let i = 0; i < 3; i++) smsIds.push(await alert({}, [{ channel: 'SMS', destination: PHONE }]));
      for (let i = 0; i < 15; i++) await alert({}, [{ channel: 'EMAIL', destination: EMAIL }]);
      await drain(a.app.get(DeliveryWorker), 10);
      expect(calls()).toBe(33);
      const lastSms = Math.max(...sms.calls.map((c) => c.at));
      const lateEmails = email.calls.slice(15).map((c) => c.at);
      expect(lateEmails.every((at) => at >= lastSms)).toBe(true);
    });

    it('failure isolation: a failing EMAIL provider does not stop SMS deliveries; a poison delivery does not stop the others', async () => {
      const smsIds = [];
      for (let i = 0; i < 3; i++) smsIds.push(await alert({}, [{ channel: 'SMS', destination: PHONE }]));
      const emailId = await alert();
      email.behavior = () => {
        throw new Error('email provider down');
      };
      await worker.passOnce();
      for (const id of smsIds) expect(await one(id, 'SMS')).toMatchObject({ status: 'SENT' });
      expect(await one(emailId)).toMatchObject({ status: 'UNCONFIRMED' });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────── rendering, pinning, rate limit, purge

  describe('rendering and template pinning', () => {
    it('the PINNED version renders: a delivery pinned to v1 still renders v1 after v2 is published; a new delivery pins v2', async () => {
      const before = await alert();
      const v1 = await sql<Record<string, any>>(db.url, `SELECT v.* FROM notification_template_version v JOIN notification_template t ON t.id = v."templateId" WHERE t.key = 'membership.approved' AND v.channel = 'EMAIL' AND v.locale = 'en' AND v.version = 1`);
      await sql(db.url, `INSERT INTO notification_template_version ("templateId", channel, locale, version, variables, subject, "bodyText", checksum) VALUES ($1, 'EMAIL', 'en', 2, '{}', 'Membership approved (v2)', 'Version two body.', $2)`, [v1[0].templateId, 'b'.repeat(64)]);
      const after = await alert();
      await drain();
      const dBefore = await one(before);
      const dAfter = await one(after);
      expect(dBefore.templateVersionId).toBe(v1[0].id);
      expect(dAfter.templateVersionId).not.toBe(v1[0].id);
      expect(email.calls.find((c) => c.reference === dBefore.id)!.message).toMatchObject({ subject: 'Membership approved', text: 'Your membership request has been approved.' });
      expect(email.calls.find((c) => c.reference === dAfter.id)!.message).toMatchObject({ subject: 'Membership approved (v2)', text: 'Version two body.' });
    });

    it('corrupt persisted data fails safely: FAILED render_failed, no attempt, no call, no value in the logs; the rest of the pass proceeds', async () => {
      const [v] = await sql<Record<string, any>>(db.url, `SELECT v.id, v."templateId", t.category FROM notification_template_version v JOIN notification_template t ON t.id = v."templateId" WHERE t.key = 'identity.owner_new_device_login' AND v.channel = 'SMS' AND v.version = 1`);
      const nid = randomUUID();
      const poisonValue = 'poison-value-7781';
      await sql(db.url, `INSERT INTO notification (id, "sourceKind", "sourceService", "idempotencyKey", "requestHash", "templateId", category, data) VALUES ($1, 'api', 'core-caller-a', $2, $3, $4, $5, $6)`,
        [nid, `k-${nid}`, 'c'.repeat(64), v.templateId, v.category, JSON.stringify({ ipAddress: 12345, occurredAt: poisonValue })]);
      await sql(db.url, `INSERT INTO notification_delivery (id, "notificationId", channel, destination, "templateVersionId", locale, "nextAttemptAt") VALUES (gen_random_uuid(), $1, 'SMS', $2, $3, 'en', now())`, [nid, PHONE, v.id]);
      const good = await alert();
      const r = await worker.passOnce();
      expect(r).toMatchObject({ claimed: 2, failed: 1, sent: 1 });
      const d = await one(nid, 'SMS');
      expect(d).toMatchObject({ status: 'FAILED', failureClass: 'terminal', failureCode: 'render_failed', attempts: 0 });
      expect(await attempts(d.id)).toEqual([]);
      expect(sms.calls).toHaveLength(0);
      expect(await one(good)).toMatchObject({ status: 'SENT' });
      expect(JSON.stringify(allLogs())).not.toContain(poisonValue);
    });

    it('a ciphertext that no longer opens (tampered) fails safely: FAILED render_failed, nothing sent, the secret purged', async () => {
      const nid = await code({}, [{ channel: 'SMS', destination: PHONE }]);
      await sql(db.url, `ALTER TABLE notification DISABLE TRIGGER notification_purge_and_cancel_guard`);
      await sql(db.url, `UPDATE notification SET "secretCiphertext" = set_byte("secretCiphertext", 20, (get_byte("secretCiphertext", 20) + 1) % 256) WHERE id = $1`, [nid]);
      await sql(db.url, `ALTER TABLE notification ENABLE TRIGGER notification_purge_and_cancel_guard`);
      await worker.passOnce();
      expect(await one(nid, 'SMS')).toMatchObject({ status: 'FAILED', failureCode: 'render_failed' });
      expect(sms.calls).toHaveLength(0);
      expect(await secret(nid)).toEqual({ c: null, k: null });
    });

    it('the caller+template limit (notif_caller_template): over it → FAILED rate_limited, no call', async () => {
      const a = await app({ NOTIFICATION_RATE_CALLER_TEMPLATE_PER_MINUTE: '1' });
      const nid = await send({ template: 'membership.revoked', channels: [{ channel: 'EMAIL', destination: EMAIL }, { channel: 'SMS', destination: PHONE }] }, a);
      await a.app.get(DeliveryWorker).passOnce();
      const statuses = (await deliveries(nid)).map((d) => [d.status, d.failureCode]);
      expect(statuses).toContainEqual(['SENT', null]);
      expect(statuses).toContainEqual(['FAILED', 'rate_limited']);
      expect(calls()).toBe(1);
      const keys = await sql<{ key: string }>(db.url, `SELECT key FROM kit_rate_limit WHERE bucket = 'notif_caller_template'`);
      expect(JSON.stringify(keys)).not.toMatch(/@|\+216/); // caller + template only: no destination-derived key (D21)
      // notif_dest (Stage 16.9) exists, keyed by an HMAC: never a plain SHA-256 of the destination (the limiter suite covers it fully)
      const plain = [EMAIL, PHONE].flatMap((d) => [`EMAIL|${d}`, `SMS|${d}`, d]).map((d) => createHash('sha256').update(`notif_dest:${d}`).digest('hex'));
      const dest = await sql<{ key: string }>(db.url, `SELECT key FROM kit_rate_limit WHERE bucket = 'notif_dest'`);
      expect(dest.length).toBeGreaterThan(0);
      expect(dest.filter((k) => plain.includes(k.key))).toEqual([]);
    });
  });

  describe('secret purge (SDD §12.1)', () => {
    it.each([
      ['SENT', accept],
      ['FAILED', (() => ({ kind: 'rejected', failureClass: 'terminal', code: 'fake_rejected' })) as Behavior],
      ['UNCONFIRMED', (() => ({ kind: 'ambiguous', code: 'fake_ambiguous' })) as Behavior],
    ])('purged when the last delivery ends %s', async (status, behavior) => {
      const nid = await code({}, [{ channel: 'EMAIL', destination: EMAIL }]);
      email.behavior = behavior;
      if (status === 'UNCONFIRMED') await worker.passOnce(); // the first ambiguity resends the code once
      await worker.passOnce();
      expect(await one(nid)).toMatchObject({ status });
      expect(await secret(nid)).toEqual({ c: null, k: null });
    });

    it('two deliveries of one intent finishing at the same moment: the last one purges (the intent lock serializes the check)', async () => {
      const both = async (m: RenderedMessage, ctx: { reference: string; attemptId: string }) => {
        await sleep(40);
        return accept(m, ctx);
      };
      for (let i = 0; i < 5; i++) {
        email.behavior = both;
        sms.behavior = both;
        const nid = await code();
        await worker.passOnce();
        expect(Math.abs(email.calls.at(-1)!.at - sms.calls.at(-1)!.at)).toBeLessThan(40); // the two calls overlapped
        expect((await deliveries(nid)).map((d) => d.status)).toEqual(['SENT', 'SENT']);
        expect(await secret(nid), `round ${i}`).toEqual({ c: null, k: null }); // at once, not left to the purge loop
      }
    });

    it('kept while ANY delivery may still send it (one SENT, one PENDING retry); purged when the last ends', async () => {
      const nid = await code();
      sms.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: 'fake_unavailable' });
      await worker.passOnce();
      expect((await deliveries(nid)).map((d) => d.status)).toEqual(['SENT', 'PENDING']);
      expect((await secret(nid)).c).not.toBeNull();
      await purge.purgeOnce();
      expect((await secret(nid)).c).not.toBeNull(); // the purge loop keeps it too
      sms.behavior = accept;
      await makeDue((await one(nid, 'SMS')).id);
      await worker.passOnce();
      expect(await secret(nid)).toEqual({ c: null, k: null });
    });

    it('the purge loop purges past expiresAt even while a delivery is still PENDING (and nothing can send it after)', async () => {
      const nid = await code({ scheduledAt: future(60_000), expiresAt: future(61_000), data: { code: OTP, expiresAt: future(61_000) } }, [{ channel: 'SMS', destination: PHONE }]);
      const short = await code({ expiresAt: future(600), data: { code: OTP, expiresAt: future(600) } }, [{ channel: 'SMS', destination: PHONE }]);
      await sleep(700);
      expect(await purge.purgeOnce()).toBeGreaterThanOrEqual(1);
      expect(await secret(short)).toEqual({ c: null, k: null });
      expect((await secret(nid)).c).not.toBeNull(); // not expired, not finished: kept
      await makeDue((await one(short, 'SMS')).id);
      await worker.passOnce();
      expect(await one(short, 'SMS')).toMatchObject({ status: 'EXPIRED' });
      expect(sms.calls).toHaveLength(0);
    });

    it('purges CANCELLED and EXPIRED intents, and a terminal intent left with a secret by a crash (window E of the purge)', async () => {
      const cancelled = await code();
      await request(t.app.getHttpServer()).post(`/notification/notifications/${cancelled}/cancel`).set('authorization', `Bearer ${A.token}`);
      expect((await secret(cancelled)).c).not.toBeNull(); // the API cancel does not purge ...
      const crashed = await code({}, [{ channel: 'EMAIL', destination: EMAIL }]);
      vi.spyOn(worker as any, 'purgeIfFinished').mockResolvedValue(undefined);
      await worker.passOnce();
      expect(await one(crashed)).toMatchObject({ status: 'SENT' });
      expect((await secret(crashed)).c).not.toBeNull();
      vi.restoreAllMocks();
      let purged = 0;
      for (let n = await purge.purgeOnce(); n > 0; n = await purge.purgeOnce()) purged += n; // ... the purge loop does (bounded batches)
      expect(purged).toBeGreaterThanOrEqual(2);
      expect(await secret(cancelled)).toEqual({ c: null, k: null });
      expect(await secret(crashed)).toEqual({ c: null, k: null });
    });

    it('purge keeps the non-secret evidence: data, request hash, deliveries and attempts', async () => {
      const nid = await code({}, [{ channel: 'EMAIL', destination: EMAIL }]);
      await worker.passOnce();
      const [n] = await sql<Record<string, any>>(db.url, `SELECT data, "requestHash", "idempotencyKey" FROM notification WHERE id = $1`, [nid]);
      expect(Object.keys(n.data)).toEqual(['expiresAt']);
      expect(n.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await attempts((await one(nid)).id)).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────── the loop, the database, shutdown

  describe('the loop, database failure and shutdown', () => {
    it('database failure during the claim: the pass fails (logged, bounded), nothing changes, the next pass works', async () => {
      const nid = await alert();
      const dbs = t.app.get(DbService);
      vi.spyOn(dbs, 'query').mockImplementationOnce(() => Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), {})));
      await expect(worker.passOnce()).rejects.toThrow();
      expect(await one(nid)).toMatchObject({ status: 'PENDING', attempts: 0 });
      vi.restoreAllMocks();
      await worker.passOnce();
      expect(await one(nid)).toMatchObject({ status: 'SENT' });
    });

    it('a real database outage while the loop runs: passes fail and are logged; the loop continues and delivers after recovery', async () => {
      const a = await app({ NOTIFICATION_WORKER_INTERVAL_MS: '100', DB_CONNECTION_TIMEOUT_MS: '500', DB_QUERY_TIMEOUT_MS: '2000', DB_STATEMENT_TIMEOUT_MS: '1500' }, { EMAIL: email, SMS: sms }, true);
      const name = new URL(db.url).pathname.slice(1);
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`);
      try {
        await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
        await sleep(1500);
      } finally {
        await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS true`);
      }
      expect(allLogs().some((l) => String(l.msg).startsWith('notification_worker_pass_failure'))).toBe(true);
      expect(JSON.stringify(allLogs())).not.toContain(new URL(db.url).password || 'no-password-in-url');
      const nid = await alert({}, undefined, a);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && (await one(nid)).status !== 'SENT') await sleep(100);
      expect(await one(nid)).toMatchObject({ status: 'SENT' });
    }, 20_000);

    it('shutdown while idle: fast, clean', async () => {
      const a = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, env: { ...BASE_ENV, NOTIFICATION_WORKER_INTERVAL_MS: '100' }, providers: { EMAIL: email, SMS: sms } });
      every.push(a);
      const t0 = Date.now();
      await a.app.close();
      expect(Date.now() - t0).toBeLessThan(1500);
    });

    it('shutdown during a provider call: the call finishes and its outcome is persisted BEFORE the pool closes; queued claims are released', async () => {
      const a = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, env: { ...BASE_ENV, NOTIFICATION_WORKER_INTERVAL_MS: '100', NOTIFICATION_WORKER_CONCURRENCY: '1', NOTIFICATION_PROVIDER_TIMEOUT_MS: '2000' }, providers: { EMAIL: email, SMS: sms } });
      every.push(a);
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push(await alert({}, undefined, a));
      const called = deferred<void>();
      email.behavior = async (m, ctx) => {
        called.resolve();
        await sleep(600);
        return accept(m, ctx);
      };
      await called.promise;
      const t0 = Date.now();
      await a.app.close();
      const took = Date.now() - t0;
      expect(took).toBeLessThan(2000 + 2000); // bounded by the drain (timeout + 2 s)
      const rows = await Promise.all(ids.map((id) => one(id)));
      expect(rows.filter((d) => d.status === 'SENT')).toHaveLength(1);
      expect(rows.filter((d) => d.status === 'PENDING')).toHaveLength(3); // released at once, not left SENDING
      expect(rows.filter((d) => d.status === 'SENDING')).toHaveLength(0);
      expect(email.calls).toHaveLength(1);
      expect(allLogs().some((l) => String(l.msg).includes('notification_delivery_released count=3 reason=shutdown'))).toBe(true);
    });

    it('shutdown during a hanging provider call: cut by the provider timeout, recorded AMBIGUOUS, close bounded', async () => {
      const a = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, env: { ...BASE_ENV, NOTIFICATION_WORKER_INTERVAL_MS: '100' }, providers: { EMAIL: email, SMS: sms } });
      every.push(a);
      const nid = await alert({}, undefined, a);
      const called = deferred<void>();
      email.behavior = () => {
        called.resolve();
        return new Promise<ProviderResult>(() => undefined);
      };
      await called.promise;
      const t0 = Date.now();
      await a.app.close();
      expect(Date.now() - t0).toBeLessThan(TIMEOUT_MS + 2000);
      expect(await one(nid)).toMatchObject({ status: 'UNCONFIRMED', failureCode: 'provider_timeout' });
    });

    it('restart: a new instance picks up the due work and recovers what the old one left (SENDING without an attempt)', async () => {
      const nid = await alert();
      const other = await alert();
      await worker.claim(); // an instance "dies" holding both claims
      for (const id of [nid, other]) await expireLease((await one(id)).id);
      const fresh = await app();
      await drain(fresh.app.get(DeliveryWorker));
      expect((await one(nid)).status).toBe('SENT');
      expect((await one(other)).status).toBe('SENT');
      expect(email.calls).toHaveLength(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────── leak scan

  describe('leak scan (sentinels)', () => {
    it('no code, destination, rendered content, ciphertext or key in logs, errors, attempts or any row outside the intended columns', async () => {
      const nid = await code();
      const alertId = await alert({}, [{ channel: 'EMAIL', destination: EMAIL }]);
      const [{ c }] = await sql<{ c: Buffer }>(db.url, `SELECT "secretCiphertext" AS c FROM notification WHERE id = $1`, [nid]);
      email.behavior = () => ({ kind: 'ambiguous', code: `raw provider text ${EMAIL}` });
      sms.behavior = () => ({ kind: 'rejected', failureClass: 'retryable', code: `raw ${PHONE} ${OTP}` });
      await worker.passOnce();
      email.behavior = accept;
      sms.behavior = accept;
      await makeDue((await one(nid, 'SMS')).id);
      await drain();
      expect((await deliveries(nid)).map((d) => d.status)).toEqual(['SENT', 'SENT']);
      expect(await one(alertId)).toMatchObject({ status: 'UNCONFIRMED' });
      const rendered = sms.calls[0].message.text;
      const sentinels = [OTP, EMAIL, PHONE, rendered, email.calls[0].message.text, c.toString('base64'), c.toString('hex'), TEST_SECRET_KEYS.split(':')[1],
        TEST_REQUEST_HASH_KEY.toString('base64'), A.token, 'raw provider text'];
      const logs = JSON.stringify(allLogs());
      for (const s of sentinels) expect(logs.includes(s), `log leak of sentinel #${sentinels.indexOf(s)}`).toBe(false);
      // Every table, every row, as JSON: the code, the ciphertext and the keys appear nowhere; destinations only in their snapshot column.
      const tables = await sql<{ t: string }>(db.url, `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`);
      for (const { t: table } of tables) {
        const dump = JSON.stringify(await sql(db.url, `SELECT row_to_json(x) AS r FROM "${table}" x`));
        const rowSentinels = { OTP, rendered, ciphertextHex: c.toString('hex'), secretKey: TEST_SECRET_KEYS.split(':')[1], hashKey: TEST_REQUEST_HASH_KEY.toString('base64'), token: A.token, providerText: 'raw provider text' };
        for (const [name, s] of Object.entries(rowSentinels)) expect(dump.includes(s), `${table} holds ${name}`).toBe(false);
        if (table !== 'notification_delivery') for (const s of [EMAIL, PHONE]) expect(dump.includes(s), `${table} holds a destination`).toBe(false);
      }
      const view = await request(t.app.getHttpServer()).get(`/notification/notifications/${nid}`).set('authorization', `Bearer ${A.token}`);
      for (const s of [OTP, EMAIL, PHONE]) expect(JSON.stringify(view.body)).not.toContain(s);
    });
  });
});

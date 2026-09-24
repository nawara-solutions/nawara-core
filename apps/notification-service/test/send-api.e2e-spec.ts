import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DbService, canonicalJson, generateServiceToken, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { NotificationSecretCipher } from '../src/secrets/secret-cipher.js';
import { stableUuid } from '../src/templates/catalog.js';
import { ALL_TEMPLATES, TEST_REQUEST_HASH_KEY, TEST_SECRET_KEYS, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 16.6: the internal send API on a real PostgreSQL with the real application module (SDD §7.2, §9, §11.2; Stage 16.6 decision on
 * the keyed request hash). Two callers: A (every template, both channels, organizations "request") and B (one template, EMAIL only,
 * organizations "none").
 */
const A = generateServiceToken();
const B = generateServiceToken();
const OTP = '305917'; // a sentinel one-time code
const EMAIL = 'api-leak-probe@example.test';
const PHONE = '+21620000003';
const POLICY = JSON.stringify({
  callers: {
    'core-caller-a': { templates: [...ALL_TEMPLATES, 'marketing.never_published'], channels: ['EMAIL', 'SMS'], organizations: 'request' },
    'core-caller-b': { templates: ['membership.approved'], channels: ['EMAIL'], organizations: 'none' },
  },
});
const TOKENS = [{ caller: 'core-caller-a', digest: A.digest }, { caller: 'core-caller-b', digest: B.digest }];
const future = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const codeBody = (over: Record<string, unknown> = {}) => ({
  template: 'identity.contact_verification_code',
  recipient: { type: 'user', id: 'u-api-1' },
  channels: [{ channel: 'SMS', destination: PHONE }, { channel: 'EMAIL', destination: EMAIL }],
  data: { code: OTP, expiresAt: future(600) },
  expiresAt: future(600),
  ...over,
});
const key = () => `key-${randomUUID()}`;

describeWithEnv('notification send API (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const extra: TestApp[] = [];
  const server = () => t.app.getHttpServer();
  const post = (token: string | undefined, idem: string | undefined, body: unknown, app = t) => {
    let r = request(app.app.getHttpServer()).post('/notification/notifications');
    if (token) r = r.set('authorization', `Bearer ${token}`);
    if (idem !== undefined) r = r.set('idempotency-key', idem);
    return typeof body === 'string' ? r.set('content-type', 'application/json').send(body) : r.send(body as object);
  };
  const count = async (table: string, where = 'true', params: unknown[] = []) => (await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0].n;
  const byKey = async (caller: string, k: string) => (await sql<Record<string, any>>(db.url, `SELECT * FROM notification WHERE "sourceService" = $1 AND "idempotencyKey" = $2`, [caller, k]))[0];

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifapi');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, policy: POLICY });
  });
  afterEach(async () => {
    for (const a of extra.splice(0)) await a.app.close();
  });
  afterAll(async () => {
    await t?.app.close();
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${new URL(db.url).pathname.slice(1)}" WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
    await db.drop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── authentication and caller policy

  describe('authentication: a Core service token, the caller taken from it and nothing else', () => {
    it.each([
      ['no token', undefined], ['a wrong token', 'not-a-real-token'], ['an unregistered token', generateServiceToken().token],
      ['a user-shaped JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2ln'],
    ])('%s → 401 on every route, nothing written', async (_l, token) => {
      const before = await count('notification');
      expect((await post(token, key(), codeBody())).status).toBe(401);
      const auth = (r: request.Test) => (token ? r.set('authorization', `Bearer ${token}`) : r);
      expect((await auth(request(server()).get(`/notification/notifications/${randomUUID()}`))).status).toBe(401);
      expect((await auth(request(server()).post(`/notification/notifications/${randomUUID()}/cancel`))).status).toBe(401);
      expect(await count('notification')).toBe(before);
    });

    it('a caller cannot impersonate another: a caller field in the body is refused, a caller header is ignored', async () => {
      expect((await post(B.token, key(), { ...codeBody(), sourceService: 'core-caller-a' })).body).toMatchObject({ statusCode: 400, code: 'validation_error' });
      const k = key();
      const r = await request(server()).post('/notification/notifications').set('authorization', `Bearer ${B.token}`).set('idempotency-key', k).set('x-caller', 'core-caller-a')
        .send({ template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] });
      expect(r.status).toBe(202);
      expect((await byKey('core-caller-b', k)).sourceService).toBe('core-caller-b');
    });
  });

  describe('caller policy (NOTIFICATION_SERVICE_POLICY): templates, channels, organizations', () => {
    it.each([
      ['a template outside its list (a SECURITY one)', { template: 'identity.contact_verification_code', channels: [{ channel: 'EMAIL', destination: EMAIL }], data: { code: '1', expiresAt: future(60) } }, 'template_not_allowed'],
      ['a channel outside its list', { template: 'membership.approved', channels: [{ channel: 'SMS', destination: PHONE }] }, 'channel_not_allowed'],
      ['an organization when its policy is "none"', { template: 'membership.approved', organizationId: randomUUID(), channels: [{ channel: 'EMAIL', destination: EMAIL }] }, 'organization_not_allowed'],
    ])('caller B: %s → 403 %s, nothing written', async (_l, body, code) => {
      const before = await count('notification');
      const r = await post(B.token, key(), body);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe(code);
      expect(await count('notification')).toBe(before);
    });

    it('the category is the template\'s, never the caller\'s: a category field is refused', async () => {
      expect((await post(A.token, key(), { ...codeBody(), category: 'OPTIONAL' })).body.code).toBe('validation_error');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────── the request

  describe('request validation (400) and business refusals (404 / 422), nothing written', () => {
    it.each([
      ['no Idempotency-Key', undefined, codeBody(), 400, 'idempotency_key_required'],
      ['an empty Idempotency-Key', '', codeBody(), 400, 'idempotency_key_required'],
      ['a short Idempotency-Key', 'short', codeBody(), 400, 'validation_error'],
      ['an Idempotency-Key with spaces', 'has spaces in it', codeBody(), 400, 'validation_error'],
      ['an unknown field', 'k-unknown-field-1', { ...codeBody(), subject: 'x' }, 400, 'validation_error'],
      ['a template version id', 'k-version-field-1', { ...codeBody(), templateVersionId: randomUUID() }, 400, 'validation_error'],
      ['a provider', 'k-provider-field', { ...codeBody(), channels: [{ channel: 'SMS', destination: PHONE, provider: 'x' }] }, 400, 'validation_error'],
      ['IN_APP', 'k-in-app-channel', { ...codeBody(), channels: [{ channel: 'IN_APP', destination: 'x' }] }, 400, 'validation_error'],
      ['PUSH', 'k-push-channel-1', { ...codeBody(), channels: [{ channel: 'PUSH', destination: 'x' }] }, 400, 'validation_error'],
      ['no channel', 'k-no-channel-01', { ...codeBody(), channels: [] }, 400, 'validation_error'],
      ['a bad locale', 'k-bad-locale-01', { ...codeBody(), locale: 'fr_FR' }, 400, 'validation_error'],
      ['a bad date', 'k-bad-date-0001', { ...codeBody(), scheduledAt: 'tomorrow' }, 400, 'validation_error'],
      ['a published key the caller lists but that has no version', 'k-unpublished-1', { template: 'marketing.never_published', channels: [{ channel: 'EMAIL', destination: EMAIL }] }, 404, 'unknown_template'],
      ['a channel twice', 'k-duplicate-ch1', { ...codeBody(), channels: [{ channel: 'SMS', destination: PHONE }, { channel: 'SMS', destination: '+21620000009' }] }, 422, 'duplicate_channel'],
      ['a past schedule', 'k-past-schedule', { ...codeBody(), scheduledAt: new Date(Date.now() - 1000).toISOString(), expiresAt: undefined }, 422, 'schedule_out_of_range'],
      ['a schedule beyond NOTIFICATION_MAX_SCHEDULE_AHEAD_SEC', 'k-far-schedule1', { ...codeBody(), scheduledAt: future(31 * 86400), expiresAt: undefined }, 422, 'schedule_out_of_range'],
      ['an expiry before the schedule', 'k-expiry-before', { ...codeBody(), scheduledAt: future(600), expiresAt: future(300) }, 422, 'schedule_out_of_range'],
      ['a missing required variable', 'k-missing-var01', { ...codeBody(), data: { code: OTP } }, 422, 'invalid_template_data'],
      ['an unknown variable', 'k-unknown-var01', { ...codeBody(), data: { code: OTP, expiresAt: future(60), extra: 1 } }, 422, 'invalid_template_data'],
      ['a code that is not a code', 'k-bad-code-0001', { ...codeBody(), data: { code: '30-59', expiresAt: future(60) } }, 422, 'invalid_template_data'],
    ])('%s → %i %s', async (_l, idem, body, status, code) => {
      const before = await count('notification');
      const r = await post(A.token, idem, body);
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ statusCode: status, code });
      expect(typeof r.body.requestId).toBe('string');
      expect(await count('notification')).toBe(before);
      expect(JSON.stringify(r.body)).not.toContain(OTP);
    });
  });

  describe('destinations (D20 strict on the API too): 422 invalid_destination, nothing written, nothing normalized', () => {
    it.each(['21620000003', '20000003', '+021620000003', '+216 20 000 003', '0021620000003'])('SMS %s → 422', async (phone) => {
      const before = await count('notification');
      const r = await post(A.token, key(), codeBody({ channels: [{ channel: 'SMS', destination: phone }] }));
      expect([r.status, r.body.code]).toEqual([422, 'invalid_destination']);
      expect(JSON.stringify(r.body)).not.toContain(phone);
      expect(await count('notification')).toBe(before);
    });
    it.each(['+21620000003', '+14155552671'])('SMS %s → 202, stored exactly', async (phone) => {
      const k = key();
      expect((await post(A.token, k, codeBody({ channels: [{ channel: 'SMS', destination: phone }] }))).status).toBe(202);
      const n = await byKey('core-caller-a', k);
      expect((await sql(db.url, 'SELECT destination FROM notification_delivery WHERE "notificationId" = $1', [n.id]))[0].destination).toBe(phone);
    });
    it.each(['not-an-address', 'a@b', ' person@example.test', 'p@exa mple.test'])('EMAIL %j → 422', async (email) => {
      const r = await post(A.token, key(), codeBody({ channels: [{ channel: 'EMAIL', destination: email }] }));
      expect([r.status, r.body.code]).toEqual([422, 'invalid_destination']);
    });
    it('one invalid channel refuses the whole request (no partial intent)', async () => {
      const before = await count('notification_delivery');
      const r = await post(A.token, key(), codeBody({ channels: [{ channel: 'EMAIL', destination: EMAIL }, { channel: 'SMS', destination: '20000003' }] }));
      expect(r.status).toBe(422);
      expect(await count('notification_delivery')).toBe(before);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────── accepted intents

  describe('an accepted request: one intent and all its deliveries, committed before the 202', () => {
    it('202 with the SDD body; rows: api identity, keyed hash, pinned versions, PENDING due now, the code sealed, 0 attempts', async () => {
      const k = key();
      const r = await post(A.token, k, codeBody());
      expect(r.status).toBe(202);
      expect(Object.keys(r.body).sort()).toEqual(['deliveries', 'id', 'status']);
      expect(r.body.status).toBe('accepted');
      expect(r.body.deliveries.map((d: any) => [d.channel, d.status])).toEqual([['EMAIL', 'PENDING'], ['SMS', 'PENDING']]);
      const n = await byKey('core-caller-a', k);
      expect(n).toMatchObject({ id: r.body.id, sourceKind: 'api', sourceEventId: null, category: 'SECURITY', recipientType: 'user', recipientId: 'u-api-1' });
      expect(n.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(n.data)).toEqual(['expiresAt']); // the non-secret variable only
      expect(JSON.stringify(n.data)).not.toContain(OTP);
      expect(new NotificationSecretCipher(new Map([['t1', Buffer.from(TEST_SECRET_KEYS.slice(3), 'base64')]]), 't1').open(n.secretCiphertext, 't1', n.id)).toEqual({ code: OTP });
      const d = await sql<Record<string, any>>(db.url, 'SELECT * FROM notification_delivery WHERE "notificationId" = $1 ORDER BY channel', [n.id]);
      expect(d.map((x) => [x.channel, x.status, x.locale, x.templateVersionId, x.attempts])).toEqual([
        ['EMAIL', 'PENDING', 'en', stableUuid('identity.contact_verification_code|EMAIL|en|v1'), 0],
        ['SMS', 'PENDING', 'en', stableUuid('identity.contact_verification_code|SMS|en|v1'), 0],
      ]);
      expect(d.map((x) => x.id).sort()).toEqual(r.body.deliveries.map((x: any) => x.id).sort());
    });

    it('a schedule is PENDING with its due time (no SCHEDULED state); the locale resolves per channel', async () => {
      await sql(db.url, `INSERT INTO notification_template_version ("templateId", channel, locale, version, variables, subject, "bodyText", checksum) VALUES ($1, 'EMAIL', 'fr', 1, '{}', 'S', 'B', $2)`,
        [stableUuid('membership.approved'), 'f'.repeat(64)]);
      const at = future(3600);
      const k = key();
      expect((await post(A.token, k, { template: 'membership.approved', locale: 'fr-TN', scheduledAt: at, channels: [{ channel: 'EMAIL', destination: EMAIL }, { channel: 'SMS', destination: PHONE }] })).status).toBe(202);
      const n = await byKey('core-caller-a', k);
      const d = await sql<Record<string, any>>(db.url, 'SELECT channel, locale, status, "nextAttemptAt" FROM notification_delivery WHERE "notificationId" = $1 ORDER BY channel', [n.id]);
      expect(d.map((x) => [x.channel, x.locale, x.status, x.nextAttemptAt.toISOString()])).toEqual([['EMAIL', 'fr', 'PENDING', at], ['SMS', 'en', 'PENDING', at]]);
      expect(n.requestedLocale).toBe('fr-TN');
    });

    it('pins the exact version: a request after v2 is published pins v2; the earlier one keeps v1', async () => {
      const a = key();
      await post(A.token, a, { template: 'membership.rejected', channels: [{ channel: 'EMAIL', destination: EMAIL }] });
      await sql(db.url, `INSERT INTO notification_template_version ("templateId", channel, locale, version, variables, subject, "bodyText", checksum) VALUES ($1, 'EMAIL', 'en', 2, '{}', 'S2', 'B2', $2)`,
        [stableUuid('membership.rejected'), 'e'.repeat(64)]);
      const b = key();
      await post(A.token, b, { template: 'membership.rejected', channels: [{ channel: 'EMAIL', destination: EMAIL }] });
      const version = async (k: string) => (await sql(db.url, `SELECT v.version FROM notification_delivery d JOIN notification_template_version v ON v.id = d."templateVersionId" JOIN notification n ON n.id = d."notificationId" WHERE n."idempotencyKey" = $1`, [k]))[0].version;
      expect([await version(a), await version(b)]).toEqual([1, 2]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────── idempotency

  describe('idempotency: (authenticated caller, Idempotency-Key) + the keyed request hash', () => {
    it('same key, same body → the same 202, one intent; property order and whitespace do not matter', async () => {
      const k = key();
      const body = codeBody();
      const first = await post(A.token, k, body);
      const again = await post(A.token, k, body);
      const reordered = JSON.stringify(Object.fromEntries(Object.entries(body).reverse()), null, 3);
      const third = await post(A.token, k, reordered);
      expect([first.status, again.status, third.status]).toEqual([202, 202, 202]);
      expect(again.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);
      expect(await count('notification', '"idempotencyKey" = $1', [k])).toBe(1);
      expect(await count('notification_delivery', '"notificationId" = $1', [first.body.id])).toBe(2);
    });

    it('same key, a changed NON-secret field → 422 idempotency_key_reused', async () => {
      const k = key();
      await post(A.token, k, codeBody());
      const r = await post(A.token, k, codeBody({ recipient: { type: 'user', id: 'u-other' } }));
      expect([r.status, r.body.code]).toEqual([422, 'idempotency_key_reused']);
    });

    it('same key, a changed SECRET (the one-time code) → 422 idempotency_key_reused', async () => {
      const k = key();
      const body = codeBody();
      await post(A.token, k, body);
      const r = await post(A.token, k, { ...body, data: { ...body.data, code: '305918' } });
      expect([r.status, r.body.code]).toEqual([422, 'idempotency_key_reused']);
      expect(JSON.stringify(r.body)).not.toMatch(/30591[78]/);
    });

    it('another caller with the same key is another namespace', async () => {
      const k = key();
      const body = { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] };
      const a = await post(A.token, k, body);
      const b = await post(B.token, k, body);
      expect([a.status, b.status]).toEqual([202, 202]);
      expect(a.body.id).not.toBe(b.body.id);
    });

    it('10 CONCURRENT identical requests: one intent, every response the same 202', async () => {
      const k = key();
      const body = codeBody();
      const rs = await Promise.all(Array.from({ length: 10 }, () => post(A.token, k, body)));
      expect(rs.map((r) => r.status)).toEqual(Array(10).fill(202));
      expect(new Set(rs.map((r) => JSON.stringify(r.body))).size).toBe(1);
      expect(await count('notification', '"idempotencyKey" = $1', [k])).toBe(1);
      expect(await count('notification_delivery', '"notificationId" = $1', [rs[0].body.id])).toBe(2);
    });

    it('8 CONCURRENT requests, one key, 8 different codes: exactly one owns the key; the 7 others are 422', async () => {
      const k = key();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => post(A.token, k, codeBody({ data: { code: `50000${i}`, expiresAt: future(600) } }))));
      expect(rs.filter((r) => r.status === 202)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 422 && r.body.code === 'idempotency_key_reused')).toHaveLength(7);
      expect(await count('notification', '"idempotencyKey" = $1', [k])).toBe(1);
    });

    it('a retry after a lost response (the commit happened, the answer did not arrive) → the same intent, no duplicate', async () => {
      const k = key();
      const body = codeBody();
      const dbs = t.app.get(DbService);
      const original = dbs.tx.bind(dbs);
      const spy = vi.spyOn(dbs, 'tx').mockImplementationOnce(async (fn: any, iso?: any) => {
        await original(fn, iso); // committed
        throw new Error('simulated: the response is lost after the commit');
      });
      const lost = await post(A.token, k, body);
      spy.mockRestore();
      expect(lost.status).toBe(500); // the client never saw a 202
      expect(await count('notification', '"idempotencyKey" = $1', [k])).toBe(1);
      const retry = await post(A.token, k, body);
      expect(retry.status).toBe(202);
      expect(retry.body.id).toBe((await byKey('core-caller-a', k)).id);
      expect(await count('notification', '"idempotencyKey" = $1', [k])).toBe(1);
    });

    it('a retry after a RESTART replays the same intent (the identity is durable)', async () => {
      const k = key();
      const body = codeBody();
      const first = await post(A.token, k, body);
      const restarted = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, policy: POLICY });
      extra.push(restarted);
      const again = await post(A.token, k, body, restarted);
      expect(again.status).toBe(202);
      expect(again.body).toEqual(first.body);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────── the keyed hash and secrets

  describe('security: the one-time code cannot be recovered from the database without NOTIFICATION_REQUEST_HASH_KEY', () => {
    it('the stored hash is HMAC-SHA-256 under the key; an exhaustive unkeyed search of all 10^6 codes over the known body never matches it', async () => {
      const k = key();
      const body = codeBody();
      await post(A.token, k, body);
      const n = await byKey('core-caller-a', k);
      // What an attacker with the database and the known shape of the request can reconstruct: everything except the code.
      const known = (code: string) => canonicalJson({ ...body, data: { ...body.data, code } });
      expect(createHmac('sha256', TEST_REQUEST_HASH_KEY).update(`nawara.notification.api.v1|${known(OTP)}`).digest('hex')).toBe(n.requestHash); // with the key: it is the request
      let matches = 0;
      for (let i = 0; i < 1_000_000; i++) {
        const c = String(i).padStart(6, '0');
        const doc = known(c);
        if (createHash('sha256').update(doc).digest('hex') === n.requestHash) matches++;
        if (createHash('sha256').update(`nawara.notification.api.v1|${doc}`).digest('hex') === n.requestHash) matches++;
      }
      expect(matches).toBe(0); // without the key, not one of the 10^6 codes verifies against the stored hash
    }, 120_000);

    it('a database dump holds the hash, but never the code, a destination in a log, the hash key or the secret key; responses and logs neither', async () => {
      const k = key();
      const accepted = await post(A.token, k, codeBody());
      const status = await request(server()).get(`/notification/notifications/${accepted.body.id}`).set('authorization', `Bearer ${A.token}`);
      await post(A.token, k, codeBody({ data: { code: '999999', expiresAt: future(60) } })); // a conflict
      await post(A.token, key(), codeBody({ data: { code: `${OTP}-x`, expiresAt: future(60) } })); // invalid data
      const dump = (await sql<{ t: string }>(db.url, `SELECT (SELECT string_agg(row_to_json(n)::text, '') FROM notification n) || (SELECT string_agg(row_to_json(d)::text, '') FROM notification_delivery d) AS t`))[0].t;
      expect(dump).toContain((await byKey('core-caller-a', k)).requestHash);
      const hashKeyForms = [TEST_REQUEST_HASH_KEY.toString('base64'), TEST_REQUEST_HASH_KEY.toString('hex')];
      const secretKeyForms = [TEST_SECRET_KEYS.slice(3), Buffer.from(TEST_SECRET_KEYS.slice(3), 'base64').toString('hex')];
      for (const s of [OTP, ...hashKeyForms, ...secretKeyForms]) expect(dump, s.slice(0, 6)).not.toContain(s);
      const logs = JSON.stringify(t.logs);
      expect(t.logs.some((l) => String(l.msg).startsWith('notification_api_accepted'))).toBe(true);
      for (const s of [OTP, EMAIL, PHONE, A.token, B.token, A.digest, ...hashKeyForms, ...secretKeyForms]) expect(logs, s.slice(0, 6)).not.toContain(s);
      const responses = JSON.stringify([accepted.body, status.body]);
      for (const s of [OTP, EMAIL, PHONE, ...hashKeyForms]) expect(responses).not.toContain(s);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────── status and cancellation

  describe('status: the creating caller only; derived, never data, secrets or full destinations', () => {
    it('200 for the creator with the derived status and destination hints; 404 for another caller, an unknown id and a malformed id', async () => {
      const k = key();
      const r = await post(A.token, k, codeBody());
      const g = await request(server()).get(`/notification/notifications/${r.body.id}`).set('authorization', `Bearer ${A.token}`).expect(200);
      expect(g.body).toMatchObject({ id: r.body.id, template: 'identity.contact_verification_code', category: 'SECURITY', status: 'IN_PROGRESS', cancelledAt: null, organizationId: null });
      expect(g.body.deliveries.map((d: any) => [d.channel, d.status, d.destinationHint, d.templateVersion, d.attempts])).toEqual([['EMAIL', 'PENDING', '…st', 1, 0], ['SMS', 'PENDING', '…03', 1, 0]]);
      expect(Object.keys(g.body)).not.toContain('data');
      for (const [path, token] of [[r.body.id, B.token], [randomUUID(), A.token], ['not-a-uuid', A.token]]) {
        const other = await request(server()).get(`/notification/notifications/${path}`).set('authorization', `Bearer ${token}`);
        expect([other.status, other.body.code]).toEqual([404, 'notification_not_found']);
      }
    });
  });

  describe('cancellation (SDD §9.3): the creating caller only; PENDING → CANCELLED; SENDING cannot be recalled', () => {
    const cancel = (id: string, token = A.token) => request(server()).post(`/notification/notifications/${id}/cancel`).set('authorization', `Bearer ${token}`);

    it('cancels every PENDING delivery, stamps the intent, derives CANCELLED; repeating it is 200 with the same state; another caller gets 404', async () => {
      const { body } = await post(A.token, key(), codeBody());
      expect((await cancel(body.id, B.token)).status).toBe(404);
      const c = await cancel(body.id).expect(200);
      expect(c.body.status).toBe('CANCELLED');
      expect(c.body.cancelledAt).not.toBeNull();
      expect(c.body.deliveries.map((d: any) => d.status)).toEqual(['CANCELLED', 'CANCELLED']);
      const again = await cancel(body.id).expect(200);
      expect(again.body).toEqual(c.body);
      const [n] = await sql(db.url, 'SELECT "cancelledBy" FROM notification WHERE id = $1', [body.id]);
      expect(n.cancelledBy).toBe('core-caller-a');
    });

    it('a delivery already SENDING: 409 delivery_in_progress, the pending one IS cancelled, the sending one is untouched', async () => {
      const { body } = await post(A.token, key(), codeBody());
      await sql(db.url, `UPDATE notification_delivery SET status = 'SENDING', "nextAttemptAt" = NULL, "leaseUntil" = now() + interval '1 minute' WHERE "notificationId" = $1 AND channel = 'SMS'`, [body.id]);
      const r = await cancel(body.id);
      expect([r.status, r.body.code]).toEqual([409, 'delivery_in_progress']);
      const d = await sql(db.url, 'SELECT channel, status FROM notification_delivery WHERE "notificationId" = $1 ORDER BY channel', [body.id]);
      expect(d.map((x) => [x.channel, x.status])).toEqual([['EMAIL', 'CANCELLED'], ['SMS', 'SENDING']]);
      const g = await request(server()).get(`/notification/notifications/${body.id}`).set('authorization', `Bearer ${A.token}`);
      expect([g.body.status, g.body.cancelledAt !== null]).toEqual(['IN_PROGRESS', true]); // the pre-send check of 16.7 reads cancelledAt
    });

    it('all deliveries already terminal: 200 and nothing changes (no cancel stamp)', async () => {
      const { body } = await post(A.token, key(), { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] });
      await sql(db.url, `UPDATE notification_delivery SET status = 'SENDING', "nextAttemptAt" = NULL, "leaseUntil" = now() + interval '1 minute' WHERE "notificationId" = $1`, [body.id]);
      await sql(db.url, `UPDATE notification_delivery SET status = 'SENT', "leaseUntil" = NULL, "sentAt" = now(), "completedAt" = now() WHERE "notificationId" = $1`, [body.id]);
      const r = await cancel(body.id).expect(200);
      expect([r.body.status, r.body.cancelledAt, r.body.deliveries[0].status]).toEqual(['COMPLETED', null, 'SENT']);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────── failures, limits, parity, readiness

  describe('failures, limits and parity', () => {
    it('the database down: no 202 (500), nothing written; after recovery the same key and body is accepted once', async () => {
      const name = new URL(db.url).pathname.slice(1);
      const k = key();
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`);
      await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = 'notification-service'`, [name]);
      const down = await post(A.token, k, codeBody());
      await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS true`);
      expect(down.status).toBe(500);
      expect(JSON.stringify(down.body)).not.toMatch(/database|postgres|ECONN|57P|password/i);
      expect(await count('notification', '"idempotencyKey" = $1', [k])).toBe(0);
      expect((await post(A.token, k, codeBody())).status).toBe(202);
      expect(await count('notification', '"idempotencyKey" = $1', [k])).toBe(1);
    });

    it('the per-caller intake limit (notif_api_caller, keyed by caller name only): 429 rate_limited past the limit', async () => {
      const limited = await createTestApp({ databaseUrl: db.url, tokens: [{ caller: 'core-caller-c', digest: A.digest }], env: { NOTIFICATION_API_INTAKE_LIMIT_PER_MINUTE: '3' } });
      extra.push(limited);
      const rs = [];
      for (let i = 0; i < 4; i++) rs.push((await post(A.token, key(), { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] }, limited)).status);
      expect(rs).toEqual([202, 202, 202, 429]);
    });

    it('API and event intake share the core rules: the same template, destination and data give the same pinned version, locale, data and sealed secret', async () => {
      const k = key();
      const exp = future(600);
      await post(A.token, k, { template: 'identity.operator_login_code', channels: [{ channel: 'SMS', destination: PHONE }], data: { code: OTP, expiresAt: exp } });
      const id = randomUUID();
      const event: EventEnvelope = { id, name: 'admin.operator_code_issued', payload: { userId: 'u-1', channel: 'phone', destination: PHONE, code: OTP, expiresAt: exp, timestamp: new Date().toISOString() },
        headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1 } };
      await t.intake.handle(event);
      const rows = await sql<Record<string, any>>(db.url, `SELECT n.id, n.data, n."secretKeyId", n.category, d."templateVersionId", d.locale, d.destination, d.status FROM notification n JOIN notification_delivery d ON d."notificationId" = n.id
        WHERE n."idempotencyKey" = $1 OR n."sourceEventId" = $2 ORDER BY n."sourceKind"`, [k, id]);
      expect(rows).toHaveLength(2);
      const [api, evt] = rows;
      for (const f of ['data', 'secretKeyId', 'category', 'templateVersionId', 'locale', 'destination', 'status']) expect(api[f], f).toEqual(evt[f]);
      // the event path refuses the same invalid destination as a durable FAILED delivery; the API refuses it with a 422 (SDD §7.1 vs §7.2)
      expect((await post(A.token, key(), { template: 'identity.operator_login_code', channels: [{ channel: 'SMS', destination: '20000003' }], data: { code: OTP, expiresAt: exp } })).status).toBe(422);
    });

    it('the API writes to the database directly: with no broker reachable the service is not ready (D12), yet a request is still accepted durably', async () => {
      const noBroker = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, policy: POLICY, rabbitmqUrl: 'amqp://nobody:nothing@127.0.0.1:1' });
      extra.push(noBroker);
      const ready = await request(noBroker.app.getHttpServer()).get('/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.failed).toContain('rabbitmq');
      expect((await post(A.token, key(), { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] }, noBroker)).status).toBe(202);
    });

    it('SHUTDOWN with a send request in flight: it commits and answers 202, then the service closes within its bound', async () => {
      const app = await createTestApp({ databaseUrl: db.url, tokens: TOKENS, policy: POLICY, env: { HTTP_DRAIN_TIMEOUT_MS: '3000' } });
      await app.app.listen(0, '127.0.0.1');
      const url = `http://127.0.0.1:${(app.app.getHttpServer() as { address(): AddressInfo }).address().port}/notification/notifications`;
      const dbs = app.app.get(DbService);
      const original = dbs.tx.bind(dbs);
      let inFlight = false;
      vi.spyOn(dbs, 'tx').mockImplementationOnce(async (fn: any, iso?: any) => {
        inFlight = true;
        await new Promise((r) => setTimeout(r, 1000));
        return original(fn, iso);
      });
      const k = key();
      const pending = fetch(url, { method: 'POST', headers: { authorization: `Bearer ${A.token}`, 'idempotency-key': k, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: EMAIL }] }) });
      await vi.waitFor(() => expect(inFlight).toBe(true));
      const t0 = Date.now();
      const closing = app.app.close();
      const res = await pending;
      await closing;
      expect(res.status).toBe(202);
      expect(Date.now() - t0).toBeLessThan(3000 + 2000);
      expect(await count('notification', '"idempotencyKey" = $1', [k])).toBe(1);
      expect(await count('notification_delivery d JOIN notification n ON n.id = d."notificationId"', 'n."idempotencyKey" = $1', [k])).toBe(1);
    });

    it('after the whole API suite: zero attempts, and nothing left the PENDING / CANCELLED states except the rows this suite moved by hand', async () => {
      expect(await count('notification_delivery_attempt')).toBe(0);
      expect(await count('notification_delivery', `status NOT IN ('PENDING', 'CANCELLED', 'SENDING', 'SENT')`)).toBe(0);
    });
  });
});

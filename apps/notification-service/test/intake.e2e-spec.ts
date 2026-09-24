import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentEventFailure, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { EVENT_MAP, mappingFor } from '../src/intake/event-map.js';
import { NotificationSecretCipher } from '../src/secrets/secret-cipher.js';
import { stableUuid } from '../src/templates/catalog.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 16.5: the event intake on a real PostgreSQL with the real migrations and the real application module, driving the real
 * `IntakeService` with canonical envelopes (the broker path itself is proven in event-intake-broker.e2e-spec).
 */
const CODE = '738164'; // a sentinel one-time code: it must appear nowhere but in the sealed ciphertext
const EMAIL = 'leak-probe.person@example.test';
const PHONE = '+21620000003';
const IP = '203.0.113.99';
const ORG = randomUUID();
const future = (s: number) => new Date(Date.now() + s * 1000).toISOString();

/** A canonical kit envelope, exactly what Auth publishes since Stage 16.2. */
function envelope(name: string, payload: Record<string, unknown>, over: Partial<EventEnvelope['headers']> = {}): EventEnvelope {
  const id = randomUUID();
  return { id, name, payload, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1, correlationId: `corr-${id.slice(0, 8)}`, ...over } };
}

/** A valid payload for every mapped event (Auth's exact shapes), on the given channel. */
function payloadFor(name: string, channel: 'email' | 'phone' = 'email'): Record<string, unknown> {
  const dest = { userId: `user-${randomUUID().slice(0, 8)}`, channel, destination: channel === 'email' ? EMAIL : PHONE };
  const at = new Date().toISOString();
  switch (name) {
    case 'member.contact_verification_requested':
      return { ...dest, code: CODE, expiresAt: future(600) };
    case 'admin.operator_code_issued':
    case 'admin.operator_confirmation_code_issued':
      return { ...dest, code: CODE, expiresAt: future(3600), timestamp: at };
    case 'admin.owner_recovery_requested':
      return { ...dest, availableAt: future(86400), ipAddress: IP, timestamp: at };
    case 'admin.owner_recovery_completed':
    case 'admin.owner_login_from_new_device':
      return { ...dest, ipAddress: IP, timestamp: at };
    default:
      return { ...dest, organizationId: ORG, timestamp: at };
  }
}

describeWithEnv('event intake: canonical event → durable intent (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const count = async (table: string, where = 'true', params: unknown[] = []) =>
    (await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0].n;
  const rowsOf = async (eventId: string) => {
    const [n] = await sql<Record<string, any>>(db.url, `SELECT n.*, t.key FROM notification n JOIN notification_template t ON t.id = n."templateId" WHERE n."sourceEventId" = $1`, [eventId]);
    const d = n ? await sql<Record<string, any>>(db.url, `SELECT d.*, v.version FROM notification_delivery d JOIN notification_template_version v ON v.id = d."templateVersionId" WHERE d."notificationId" = $1`, [n.id]) : [];
    return { n, d };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifintake');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url });
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  describe('every mapped event (table-driven: the nine SDD §7.1 mappings)', () => {
    it.each(EVENT_MAP.flatMap((m) => (['email', 'phone'] as const).map((c) => [m.name, c] as const)))('%s over %s: one intent, one PENDING delivery on the right template, channel, locale and destination', async (name, channel) => {
      const m = mappingFor('auth-service', name)!;
      const e = envelope(name, payloadFor(name, channel));
      expect(await t.intake.handle(e)).toMatchObject({ kind: 'accepted', invalidDestination: false });
      const { n, d } = await rowsOf(e.id);
      expect(n).toMatchObject({ sourceKind: 'event', sourceService: 'auth-service', key: m.template, category: m.category, recipientType: 'user',
        recipientId: e.payload.userId, organizationId: m.organizationFrom ? ORG : null, correlationId: e.headers.correlationId, requestedLocale: null });
      expect(n.expiresAt?.toISOString() ?? null).toBe(m.expiresAtFrom ? e.payload[m.expiresAtFrom] : null);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ channel: channel === 'email' ? 'EMAIL' : 'SMS', destination: channel === 'email' ? EMAIL : PHONE, locale: 'en', version: 1,
        status: 'PENDING', attempts: 0, templateVersionId: stableUuid(`${m.template}|${channel === 'email' ? 'EMAIL' : 'SMS'}|en|v1`) });
      // non-secret variables in data, the secret sealed, never in data
      const expectedData = Object.fromEntries(Object.entries(m.variables).filter(([v]) => v !== 'code').map(([v, f]) => [v, e.payload[f]]));
      expect(n.data).toEqual(expectedData);
      if ('code' in m.variables) {
        expect(JSON.stringify(n.data)).not.toContain(CODE);
        expect(n.secretKeyId).toBe('t1');
        expect(new NotificationSecretCipher(t.config.secretKeys, 't1').open(n.secretCiphertext, 't1', n.id)).toEqual({ code: CODE });
      } else {
        expect(n.secretCiphertext).toBeNull();
      }
      expect(await count('notification_delivery_attempt', '"deliveryId" = $1', [d[0].id])).toBe(0);
    });
  });

  describe('destinations (D20): an invalid destination is a durable FAILED delivery, never a poison message, never a guessed country', () => {
    it.each([
      ['a local number', 'phone', '20000003'], ['a number without its +', 'phone', '21620000003'], ['a 00 prefix', 'phone', '0021620000003'],
      ['spaces', 'phone', '+216 20 000 003'], ['not an email', 'email', 'person.example.test'],
    ])('%s: recorded, delivery FAILED invalid_destination, no secret kept, destination stored exactly as received', async (_l, channel, destination) => {
      const e = envelope('member.contact_verification_requested', { ...payloadFor('member.contact_verification_requested', channel as 'email'), destination });
      expect(await t.intake.handle(e)).toMatchObject({ kind: 'accepted', invalidDestination: true });
      const { n, d } = await rowsOf(e.id);
      expect(d[0]).toMatchObject({ status: 'FAILED', failureCode: 'invalid_destination', failureClass: 'terminal', destination, attempts: 0 });
      expect(n.secretCiphertext).toBeNull(); // nothing will ever be sent: the code is not kept
      expect(await count('notification_delivery_attempt', '"deliveryId" = $1', [d[0].id])).toBe(0);
    });
  });

  describe('permanent failures: dead-lettered, nothing written', () => {
    it.each([
      ['an unmapped event', () => envelope('user.registered', { userId: 'u-1', role: 'x', organizationId: ORG, timestamp: new Date().toISOString() }), 'unmapped_event'],
      ['a mapped name from another source', () => envelope('membership.approved', payloadFor('membership.approved'), { source: 'some-other-service' }), 'unmapped_event'],
      ['an unsupported version', () => envelope('membership.approved', payloadFor('membership.approved'), { version: 2 }), 'unsupported_version'],
      ['a missing payload field', () => envelope('admin.operator_code_issued', { ...payloadFor('admin.operator_code_issued'), expiresAt: undefined }), 'malformed_payload'],
      ['a wrong channel', () => envelope('membership.revoked', { ...payloadFor('membership.revoked'), channel: 'fax' }), 'malformed_payload'],
      ['a non-uuid organization', () => envelope('membership.approved', { ...payloadFor('membership.approved'), organizationId: 'org-1' }), 'malformed_payload'],
      ['no destination', () => envelope('membership.approved', { ...payloadFor('membership.approved'), destination: null }), 'no_destination'],
      ['a code that is not a code', () => envelope('member.contact_verification_requested', { ...payloadFor('member.contact_verification_requested'), code: '12-34' }), 'invalid_template_data'],
      ['an over-long code', () => envelope('member.contact_verification_requested', { ...payloadFor('member.contact_verification_requested'), code: 'X'.repeat(13) }), 'invalid_template_data'],
      ['an over-long IP string', () => envelope('admin.owner_login_from_new_device', { ...payloadFor('admin.owner_login_from_new_device'), ipAddress: 'x'.repeat(46) }), 'invalid_template_data'],
    ])('%s → PermanentEventFailure(%s)', async (_l, make, reason) => {
      const before = await count('notification');
      const e = make();
      await expect(t.intake.handle(e)).rejects.toSatisfy((err: unknown) => err instanceof PermanentEventFailure && err.reason === reason);
      expect(await count('notification')).toBe(before);
    });

    it('a template with no published version (a deployment defect) → PermanentEventFailure(unknown_template), never another template', async () => {
      const other = await createTestApp({ databaseUrl: db.url, env: { NOTIFICATION_DEFAULT_LOCALE: 'fr' } }); // nothing is published in fr
      try {
        const before = await count('notification');
        await expect(other.intake.handle(envelope('membership.approved', payloadFor('membership.approved')))).rejects.toMatchObject({ reason: 'unknown_template' });
        expect(await count('notification')).toBe(before);
        expect(other.consumer.started).toBe(false); // and that intake never starts consuming (default locale not published)
      } finally {
        await other.app.close();
      }
    });
  });

  describe('idempotency by (sourceService, eventId)', () => {
    it('a replayed event (5 times) is one intent and one delivery; every replay is a duplicate', async () => {
      const e = envelope('admin.operator_code_issued', payloadFor('admin.operator_code_issued'));
      const outcomes = [];
      for (let i = 0; i < 5; i++) outcomes.push((await t.intake.handle(structuredClone(e))).kind);
      expect(outcomes).toEqual(['accepted', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
      expect(await count('notification', '"sourceEventId" = $1', [e.id])).toBe(1);
      expect(await count('notification_delivery d JOIN notification n ON n.id = d."notificationId"', 'n."sourceEventId" = $1', [e.id])).toBe(1);
    });

    it('12 CONCURRENT copies of one event: one intent, one delivery, 11 duplicates, no error', async () => {
      const e = envelope('member.contact_verification_requested', payloadFor('member.contact_verification_requested', 'phone'));
      const outcomes = await Promise.all(Array.from({ length: 12 }, () => t.intake.handle(structuredClone(e))));
      expect(outcomes.filter((o) => o.kind === 'accepted')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'duplicate')).toHaveLength(11);
      expect(await count('notification', '"sourceEventId" = $1', [e.id])).toBe(1);
      expect(await count('notification_delivery d JOIN notification n ON n.id = d."notificationId"', 'n."sourceEventId" = $1', [e.id])).toBe(1);
    });
  });

  describe('templates and locales', () => {
    it('pins the exact version: a delivery keeps v1 after v2 is published; a new event pins v2', async () => {
      const templateId = stableUuid('membership.revoked');
      const a = envelope('membership.revoked', payloadFor('membership.revoked'));
      await t.intake.handle(a);
      await sql(db.url, `INSERT INTO notification_template_version ("templateId", channel, locale, version, variables, subject, "bodyText", checksum)
                         VALUES ($1, 'EMAIL', 'en', 2, '{}', 'Membership revoked (v2)', 'Your membership has been revoked. (v2)', $2)`, [templateId, 'a'.repeat(64)]);
      const b = envelope('membership.revoked', payloadFor('membership.revoked'));
      await t.intake.handle(b);
      expect((await rowsOf(a.id)).d[0].version).toBe(1);
      expect((await rowsOf(b.id)).d[0].version).toBe(2);
    });

    it('resolves the locale per delivery: exact, base language, then the platform default (no locale from a phone or a country)', async () => {
      const templateId = stableUuid('membership.approved');
      for (const locale of ['fr', 'ar-TN']) {
        await sql(db.url, `INSERT INTO notification_template_version ("templateId", channel, locale, version, variables, subject, "bodyText", checksum)
                           VALUES ($1, 'EMAIL', $2, 1, '{}', 'S', 'B', $3)`, [templateId, locale, 'b'.repeat(64)]);
      }
      const m = mappingFor('auth-service', 'membership.approved')!;
      const pick = async (requested: string | null) => (await t.intake.publishedVersion(m, 'EMAIL', requested))?.locale;
      expect(await pick('ar-TN')).toBe('ar-TN');
      expect(await pick('fr-TN')).toBe('fr');
      expect(await pick('de-DE')).toBe('en');
      expect(await pick(null)).toBe('en');
      expect(await pick('not a locale')).toBe('en');
      // Auth events carry no locale: they resolve to the platform default
      const e = envelope('membership.approved', payloadFor('membership.approved'));
      await t.intake.handle(e);
      expect((await rowsOf(e.id)).d[0].locale).toBe('en');
    });
  });

  describe('security', () => {
    it('no code, destination or IP address in any log line; no plaintext code anywhere in the database but the sealed ciphertext', async () => {
      await t.intake.handle(envelope('member.contact_verification_requested', payloadFor('member.contact_verification_requested', 'phone')));
      await t.intake.handle(envelope('member.contact_verification_requested', { ...payloadFor('member.contact_verification_requested'), destination: 'bad-destination-probe' }));
      await t.intake.handle(envelope('admin.owner_login_from_new_device', payloadFor('admin.owner_login_from_new_device'))).catch(() => undefined);
      await t.intake.handle(envelope('member.contact_verification_requested', { ...payloadFor('member.contact_verification_requested'), code: `${CODE}-x` })).catch(() => undefined);
      expect(t.logs.some((l) => String(l.msg).startsWith('notification_accepted'))).toBe(true); // the scan is not vacuous
      expect(t.logs.some((l) => String(l.msg).startsWith('notification_event_rejected'))).toBe(true);
      const logs = JSON.stringify(t.logs);
      for (const s of [CODE, EMAIL, PHONE, IP, 'bad-destination-probe']) expect(logs, s).not.toContain(s);
      const dump = await sql<{ t: string }>(db.url, `SELECT (SELECT string_agg(row_to_json(n)::text, '') FROM (SELECT id, data, "recipientId", "correlationId" FROM notification) n) ||
                                                         (SELECT string_agg(row_to_json(d)::text, '') FROM notification_delivery d) AS t`);
      expect(dump[0].t).not.toContain(CODE);
    });

    it('after the whole intake suite: zero delivery attempts (no provider was called)', async () => {
      expect(await count('notification_delivery_attempt')).toBe(0);
      expect(await count('notification_delivery', `status NOT IN ('PENDING', 'FAILED')`)).toBe(0);
    });
  });
});

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { stableUuid } from '../src/templates/catalog.js';
import { failure, sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 16.4: the persistence invariants, enforced by the DATABASE itself (constraints and triggers), on a real PostgreSQL with the real
 * migrations (SDD §3-§5). Every refusal is asserted by SQLSTATE and by the constraint or the trigger's message, never by row data.
 */
const CODE_TEMPLATE = stableUuid('identity.contact_verification_code');
const ALERT_TEMPLATE = stableUuid('identity.owner_new_device_login');
const version = (key: string, channel: string, locale = 'en', v = 1) => stableUuid(`${key}|${channel}|${locale}|v${v}`);
const CODE_EMAIL = version('identity.contact_verification_code', 'EMAIL');
const CODE_SMS = version('identity.contact_verification_code', 'SMS');
const ALERT_EMAIL = version('identity.owner_new_device_login', 'EMAIL');
const STATES = ['PENDING', 'SENDING', 'SENT', 'FAILED', 'UNCONFIRMED', 'EXPIRED', 'CANCELLED'] as const;
type State = (typeof STATES)[number];
/** The frozen matrix (SDD §5.2). */
const ALLOWED = new Set(['PENDING>SENDING', 'PENDING>CANCELLED', 'PENDING>EXPIRED', 'SENDING>SENT', 'SENDING>PENDING', 'SENDING>FAILED', 'SENDING>UNCONFIRMED', 'SENDING>EXPIRED']);
/** The state fields each status requires (the CHECKs), so a refusal can only come from the transition guard. */
const FIELDS: Record<State, string> = {
  PENDING: `"nextAttemptAt" = now(), "leaseUntil" = NULL, "completedAt" = NULL`,
  SENDING: `"nextAttemptAt" = NULL, "leaseUntil" = now() + interval '1 minute'`,
  SENT: `"leaseUntil" = NULL, "nextAttemptAt" = NULL, "sentAt" = now(), "completedAt" = now()`,
  FAILED: `"leaseUntil" = NULL, "nextAttemptAt" = NULL, "failedAt" = now(), "completedAt" = now(), "failureCode" = 'provider_rejected'`,
  UNCONFIRMED: `"leaseUntil" = NULL, "nextAttemptAt" = NULL, "completedAt" = now(), "failureCode" = 'worker_lost'`,
  EXPIRED: `"leaseUntil" = NULL, "nextAttemptAt" = NULL, "completedAt" = now()`,
  CANCELLED: `"leaseUntil" = NULL, "nextAttemptAt" = NULL, "completedAt" = now()`,
};
/** How to reach each state legally from PENDING. */
const PATH: Record<State, State[]> = {
  PENDING: [], SENDING: ['SENDING'], SENT: ['SENDING', 'SENT'], FAILED: ['SENDING', 'FAILED'], UNCONFIRMED: ['SENDING', 'UNCONFIRMED'],
  EXPIRED: ['EXPIRED'], CANCELLED: ['CANCELLED'],
};

describeWithEnv('notification persistence invariants (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let url: string;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifpersist');
    url = db.url;
    await runMigrations(url, [kitMigrationsDir, notificationMigrationsDir]);
  });
  afterAll(() => db.drop());

  async function notification(over: Record<string, unknown> = {}): Promise<string> {
    const r = {
      id: randomUUID(), sourceKind: 'event', sourceService: 'auth-service', sourceEventId: randomUUID(), idempotencyKey: null, requestHash: null,
      templateId: CODE_TEMPLATE, category: 'SECURITY', organizationId: null, recipientType: 'user', recipientId: 'user-0001', data: {},
      secretCiphertext: null, secretKeyId: null, expiresAt: null, requestedLocale: null, ...over,
    } as Record<string, unknown>;
    await sql(url,
      `INSERT INTO notification (id, "sourceKind", "sourceService", "sourceEventId", "idempotencyKey", "requestHash", "templateId", category, "organizationId",
         "recipientType", "recipientId", data, "secretCiphertext", "secretKeyId", "expiresAt", "requestedLocale") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [r.id, r.sourceKind, r.sourceService, r.sourceEventId, r.idempotencyKey, r.requestHash, r.templateId, r.category, r.organizationId, r.recipientType,
        r.recipientId, JSON.stringify(r.data), r.secretCiphertext, r.secretKeyId, r.expiresAt, r.requestedLocale]);
    return r.id as string;
  }
  async function delivery(notificationId: string, over: Record<string, unknown> = {}): Promise<string> {
    const r = { id: randomUUID(), channel: 'EMAIL', destination: 'person@example.test', templateVersionId: CODE_EMAIL, locale: 'en', ...over } as Record<string, unknown>;
    await sql(url,
      `INSERT INTO notification_delivery (id, "notificationId", channel, destination, "templateVersionId", locale, "nextAttemptAt") VALUES ($1,$2,$3,$4,$5,$6, now())`,
      [r.id, notificationId, r.channel, r.destination, r.templateVersionId, r.locale]);
    return r.id as string;
  }
  const move = (id: string, to: State) => sql(url, `UPDATE notification_delivery SET status = '${to}', ${FIELDS[to]} WHERE id = $1`, [id]);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────── notification

  describe('notification: the immutable intent', () => {
    it('stores one logical recipient, a nullable organization, and has no stored status column', async () => {
      const id = await notification({ organizationId: null });
      const [row] = await sql<Record<string, unknown>>(url, 'SELECT * FROM notification WHERE id = $1', [id]);
      expect(row.organizationId).toBeNull();
      expect(row).toMatchObject({ recipientType: 'user', recipientId: 'user-0001' });
      expect(Object.keys(row)).not.toContain('status');
      expect(Object.keys(row).some((k) => /recipients|audience|segment/i.test(k))).toBe(false);
    });

    it('event identity: the same (source, eventId) is refused; another source or another event id is a new intent', async () => {
      const eventId = randomUUID();
      await notification({ sourceEventId: eventId });
      expect(await failure(url, `INSERT INTO notification ("sourceKind","sourceService","sourceEventId","templateId",category) VALUES ('event','auth-service',$1,$2,'SECURITY')`, [eventId, CODE_TEMPLATE]))
        .toMatchObject({ code: '23505', constraint: 'notification_event_identity_unique' });
      await notification({ sourceEventId: eventId, sourceService: 'another-service' });
      await notification({ sourceEventId: randomUUID() });
    });

    it('event identity under CONCURRENCY: 12 simultaneous inserts of one (source, eventId) leave exactly one intent', async () => {
      const eventId = randomUUID();
      const outcomes = await Promise.all(Array.from({ length: 12 }, async () => {
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        try {
          await c.query(`INSERT INTO notification ("sourceKind","sourceService","sourceEventId","templateId",category) VALUES ('event','auth-service',$1,$2,'SECURITY')`, [eventId, CODE_TEMPLATE]);
          return 'inserted';
        } catch (e) {
          return (e as { code?: string }).code;
        } finally {
          await c.end();
        }
      }));
      expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(1);
      expect(outcomes.filter((o) => o === '23505')).toHaveLength(11);
      expect((await sql(url, `SELECT 1 FROM notification WHERE "sourceEventId" = $1`, [eventId]))).toHaveLength(1);
    });

    it('API identity: (caller, Idempotency-Key) is unique with its request hash stored; another caller may reuse the key', async () => {
      const hash = 'a'.repeat(64);
      const api = { sourceKind: 'api', sourceEventId: null, sourceService: 'some-core-service', idempotencyKey: 'key-0001', requestHash: hash };
      const id = await notification(api);
      expect((await sql(url, 'SELECT "requestHash" FROM notification WHERE id = $1', [id]))[0].requestHash).toBe(hash);
      expect(await failure(url, `INSERT INTO notification ("sourceKind","sourceService","idempotencyKey","requestHash","templateId",category) VALUES ('api','some-core-service','key-0001',$1,$2,'SECURITY')`, ['b'.repeat(64), CODE_TEMPLATE]))
        .toMatchObject({ code: '23505', constraint: 'notification_api_identity_unique' });
      await notification({ ...api, sourceService: 'other-core-service' });
    });

    it.each([
      ['an event without its event id', { sourceEventId: null }],
      ['an event carrying an idempotency key', { idempotencyKey: 'k-1', requestHash: 'a'.repeat(64) }],
      ['an API intent without its request hash', { sourceKind: 'api', sourceEventId: null, idempotencyKey: 'k-2' }],
      ['an API intent carrying an event id', { sourceKind: 'api', idempotencyKey: 'k-3', requestHash: 'a'.repeat(64) }],
    ])('the identity fields must match the source kind: %s is refused', async (_l, over) => {
      await expect(notification(over)).rejects.toMatchObject({ code: '23514', constraint: 'notification_source_identity' });
    });

    it('the category must be the template\'s own (composite foreign key)', async () => {
      await expect(notification({ category: 'TRANSACTIONAL' })).rejects.toMatchObject({ code: '23503', constraint: 'notification_template_fk' });
    });

    it.each([
      ['a recipient type without an id', { recipientId: null }, 'notification_recipient_pair'],
      ['data that is not an object', { data: ['x'] }, 'notification_data_object'],
      ['data over 8 KB', { data: { v: 'x'.repeat(9000) } }, 'notification_data_object'],
      ['a ciphertext without its key id', { secretCiphertext: Buffer.from('c') }, 'notification_secret_pair'],
      ['a malformed requested locale', { requestedLocale: 'FR_fr' }, 'notification_requested_locale_shape'],
    ])('refuses %s', async (_l, over, constraint) => {
      await expect(notification(over)).rejects.toMatchObject({ code: '23514', constraint });
    });

    it('is immutable: no identity, template, recipient, data, schedule or expiry change', async () => {
      const id = await notification();
      for (const set of [`"recipientId" = 'user-0002'`, `data = '{"x":1}'`, `"templateId" = '${ALERT_TEMPLATE}'`, `"expiresAt" = now()`, `"sourceEventId" = gen_random_uuid()`]) {
        expect(await failure(url, `UPDATE notification SET ${set} WHERE id = $1`, [id]), set).toMatchObject({ code: '23514', message: expect.stringMatching(/is immutable/) });
      }
    });

    it('sealed secrets can only be purged (to NULL), never replaced or added later', async () => {
      const id = await notification({ secretCiphertext: Buffer.from('sealed-bytes'), secretKeyId: 'k1', expiresAt: new Date(Date.now() + 60_000) });
      expect(await failure(url, `UPDATE notification SET "secretCiphertext" = '\\x0102', "secretKeyId" = 'k2' WHERE id = $1`, [id])).toMatchObject({ code: '23514', message: expect.stringMatching(/can only be purged/) });
      await sql(url, `UPDATE notification SET "secretCiphertext" = NULL, "secretKeyId" = NULL WHERE id = $1`, [id]);
      expect(await failure(url, `UPDATE notification SET "secretCiphertext" = '\\x01', "secretKeyId" = 'k1' WHERE id = $1`, [id])).toMatchObject({ code: '23514' });
    });

    it('the cancel stamp is set once', async () => {
      const id = await notification();
      await sql(url, `UPDATE notification SET "cancelledAt" = now(), "cancelledBy" = 'some-core-service' WHERE id = $1`, [id]);
      expect(await failure(url, `UPDATE notification SET "cancelledBy" = 'other-core-service' WHERE id = $1`, [id])).toMatchObject({ code: '23514', message: expect.stringMatching(/set once/) });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── delivery

  describe('notification_delivery: one channel, a destination snapshot, a pinned version, a guarded state machine', () => {
    it('starts PENDING with a due time (scheduling = PENDING + a future nextAttemptAt; no SCHEDULED / QUEUED / RETRYING state)', async () => {
      const n = await notification();
      const d = await delivery(n);
      expect((await sql(url, 'SELECT status FROM notification_delivery WHERE id = $1', [d]))[0].status).toBe('PENDING');
      expect(await failure(url, `INSERT INTO notification_delivery ("notificationId", channel, destination, "templateVersionId", locale, status, "leaseUntil") VALUES ($1,'SMS','+21620000001',$2,'en','SENDING', now())`, [n, CODE_SMS]))
        .toMatchObject({ code: '23514', message: expect.stringMatching(/must be created PENDING/) });
      expect(await failure(url, `UPDATE notification_delivery SET status = 'SCHEDULED' WHERE id = $1`, [d])).toMatchObject({ code: '23514' });
    });

    it('one delivery per channel per intent', async () => {
      const n = await notification();
      await delivery(n);
      await expect(delivery(n, { destination: 'second@example.test' })).rejects.toMatchObject({ code: '23505', constraint: 'notification_delivery_channel_unique' });
      await delivery(n, { channel: 'SMS', destination: '+21620000002', templateVersionId: CODE_SMS });
    });

    it('stores the destination snapshot verbatim: no normalization, no default country (E.164 is validated at intake, D20)', async () => {
      const n = await notification();
      const d = await delivery(n, { channel: 'SMS', destination: '+21620000003', templateVersionId: CODE_SMS });
      expect((await sql(url, 'SELECT destination FROM notification_delivery WHERE id = $1', [d]))[0].destination).toBe('+21620000003');
      const n2 = await notification();
      const d2 = await delivery(n2, { channel: 'SMS', destination: '20000004', templateVersionId: CODE_SMS }); // a local number: stored as given, never prefixed
      expect((await sql(url, 'SELECT destination FROM notification_delivery WHERE id = $1', [d2]))[0].destination).toBe('20000004');
      await expect(delivery(await notification(), { destination: null })).rejects.toMatchObject({ code: '23514', constraint: 'notification_delivery_destination_presence' });
      await expect(delivery(await notification(), { destination: 'a\nb@example.test' })).rejects.toMatchObject({ code: '23514', constraint: 'notification_delivery_destination_bounded' });
    });

    it('pins a version of the SAME channel, locale and template', async () => {
      const n = await notification();
      await expect(delivery(n, { templateVersionId: CODE_SMS })).rejects.toMatchObject({ code: '23503', constraint: 'notification_delivery_version_fk' }); // EMAIL with an SMS version
      await expect(delivery(n, { locale: 'fr' })).rejects.toMatchObject({ code: '23503', constraint: 'notification_delivery_version_fk' });
      await expect(delivery(n, { templateVersionId: ALERT_EMAIL })).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/does not belong to the notification's template/) });
    });

    it('the transition matrix is exactly the frozen one: all 42 status changes, 8 allowed and 34 refused by the database', async () => {
      const results: string[] = [];
      for (const from of STATES) {
        for (const to of STATES) {
          if (from === to) continue;
          const d = await delivery(await notification());
          for (const step of PATH[from]) await move(d, step);
          let ok = true;
          try {
            await move(d, to);
          } catch (e) {
            ok = false;
            expect((e as { code?: string }).code, `${from}>${to}`).toBe('23514');
            expect((e as Error).message, `${from}>${to}`).toMatch(/cannot move from|is \w+ and final/);
          }
          expect(ok, `${from} > ${to}`).toBe(ALLOWED.has(`${from}>${to}`));
          results.push(`${from}>${to}:${ok ? 'ok' : 'refused'}`);
        }
      }
      expect(results.filter((r) => r.endsWith(':ok'))).toHaveLength(8);
      expect(results.filter((r) => r.endsWith(':refused'))).toHaveLength(34);
    });

    it('a terminal delivery is final in every field; the state fields must agree with the status; updatedAt follows every update', async () => {
      const d = await delivery(await notification());
      const before = (await sql<{ updatedAt: Date }>(url, 'SELECT "updatedAt" FROM notification_delivery WHERE id = $1', [d]))[0].updatedAt;
      await move(d, 'SENDING');
      const after = (await sql<{ updatedAt: Date }>(url, 'SELECT "updatedAt" FROM notification_delivery WHERE id = $1', [d]))[0].updatedAt;
      expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(await failure(url, `UPDATE notification_delivery SET "leaseUntil" = NULL WHERE id = $1`, [d])).toMatchObject({ code: '23514', constraint: 'notification_delivery_lease_iff_sending' });
      await move(d, 'SENT');
      expect(await failure(url, `UPDATE notification_delivery SET "providerMessageId" = 'rewritten' WHERE id = $1`, [d])).toMatchObject({ code: '23514', message: expect.stringMatching(/is SENT and final/) });
      expect(await failure(url, `UPDATE notification_delivery SET destination = 'other@example.test' WHERE id = $1`, [d])).toMatchObject({ code: '23514' });
    });

    it('a FAILED delivery carries a bounded failure code, never provider text', async () => {
      const d = await delivery(await notification());
      await move(d, 'SENDING');
      expect(await failure(url, `UPDATE notification_delivery SET status = 'FAILED', "leaseUntil" = NULL, "failedAt" = now(), "completedAt" = now() WHERE id = $1`, [d])).toMatchObject({ code: '23514', constraint: 'notification_delivery_failed_has_code' });
      expect(await failure(url, `UPDATE notification_delivery SET status = 'FAILED', "leaseUntil" = NULL, "failedAt" = now(), "completedAt" = now(), "failureCode" = 'The number +21620000005 is invalid' WHERE id = $1`, [d])).toMatchObject({ code: '23514', constraint: 'notification_delivery_failure_code_shape' });
    });

    it('evidence never disappears by cascade: a notification with deliveries cannot be deleted', async () => {
      const n = await notification();
      await delivery(n);
      expect(await failure(url, 'DELETE FROM notification WHERE id = $1', [n])).toMatchObject({ code: '23503' });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── attempt

  describe('notification_delivery_attempt: append-oriented evidence', () => {
    async function attempt(deliveryId: string, n: number, outcome = 'STARTED') {
      await sql(url, `INSERT INTO notification_delivery_attempt ("deliveryId", "attemptNumber", provider, outcome) VALUES ($1, $2, 'test-provider', $3)`, [deliveryId, n, outcome]);
    }

    it('is created STARTED, completed exactly once to a final outcome, then immutable; history is one row per attempt', async () => {
      const d = await delivery(await notification());
      await expect(attempt(d, 1, 'ACCEPTED')).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/must be created STARTED/) });
      await attempt(d, 1);
      await sql(url, `UPDATE notification_delivery_attempt SET outcome = 'RETRYABLE_FAILURE', "completedAt" = now(), "failureCode" = 'provider_unavailable', "latencyMs" = 120 WHERE "deliveryId" = $1 AND "attemptNumber" = 1`, [d]);
      expect(await failure(url, `UPDATE notification_delivery_attempt SET outcome = 'ACCEPTED' WHERE "deliveryId" = $1 AND "attemptNumber" = 1`, [d])).toMatchObject({ code: '23514', message: expect.stringMatching(/is RETRYABLE_FAILURE and final/) });
      await attempt(d, 2);
      expect(await failure(url, `UPDATE notification_delivery_attempt SET "completedAt" = now() WHERE "deliveryId" = $1 AND "attemptNumber" = 2`, [d])).toMatchObject({ code: '23514' }); // STARTED -> STARTED
      await sql(url, `UPDATE notification_delivery_attempt SET outcome = 'AMBIGUOUS', "completedAt" = now(), "failureCode" = 'worker_lost' WHERE "deliveryId" = $1 AND "attemptNumber" = 2`, [d]);
      expect((await sql(url, 'SELECT "attemptNumber", outcome FROM notification_delivery_attempt WHERE "deliveryId" = $1 ORDER BY 1', [d]))).toEqual([
        { attemptNumber: 1, outcome: 'RETRYABLE_FAILURE' }, { attemptNumber: 2, outcome: 'AMBIGUOUS' },
      ]);
    });

    it('(deliveryId, attemptNumber) is unique, also under concurrency', async () => {
      const d = await delivery(await notification());
      const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => attempt(d, 1)));
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected').every((o) => (o as PromiseRejectedResult).reason.code === '23505')).toBe(true);
    });

    it('its identity columns never change', async () => {
      const d = await delivery(await notification());
      await attempt(d, 1);
      for (const set of [`"attemptNumber" = 9`, `provider = 'other'`, `"startedAt" = now() - interval '1 day'`]) {
        expect(await failure(url, `UPDATE notification_delivery_attempt SET ${set} WHERE "deliveryId" = $1`, [d]), set).toMatchObject({ code: '23514' });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────── templates

  describe('templates: immutable published versions', () => {
    it('a published version cannot be modified in any column, nor deleted', async () => {
      for (const set of [`"bodyText" = 'changed'`, `subject = 'changed'`, `variables = '{}'`, `version = 9`, `locale = 'fr'`, `checksum = '${'0'.repeat(64)}'`, `"publishedAt" = now()`]) {
        expect(await failure(url, `UPDATE notification_template_version SET ${set} WHERE id = $1`, [CODE_EMAIL]), set).toMatchObject({ code: '23514', message: expect.stringMatching(/is immutable/) });
      }
      expect(await failure(url, 'DELETE FROM notification_template_version WHERE id = $1', [CODE_EMAIL])).toMatchObject({ code: '23514', message: expect.stringMatching(/cannot be deleted/) });
    });

    it('a change is a NEW version; (template, channel, locale, version) is unique', async () => {
      const insert = (v: number) => sql(url,
        `INSERT INTO notification_template_version ("templateId", channel, locale, version, variables, subject, "bodyText", checksum) VALUES ($1,'EMAIL','en',$2,'{}','S','B',$3)`,
        [ALERT_TEMPLATE, v, 'c'.repeat(64)]);
      await insert(2);
      await expect(insert(2)).rejects.toMatchObject({ code: '23505', constraint: 'notification_template_version_identity_unique' });
      const active = await sql<{ version: number }>(url, `SELECT version FROM notification_template_version WHERE "templateId" = $1 AND channel = 'EMAIL' AND locale = 'en' ORDER BY version DESC LIMIT 1`, [ALERT_TEMPLATE]);
      expect(active[0].version).toBe(2);
    });

    it.each([
      ['an email without a subject', `'EMAIL', NULL, NULL`, 'notification_template_version_email_subject'],
      ['a subject with a line break', `'EMAIL', E'a\\r\\nBcc: x', NULL`, 'notification_template_version_email_subject'],
      ['an SMS without a segment bound', `'SMS', NULL, NULL`, 'notification_template_version_sms_segments'],
      ['an SMS with a subject', `'SMS', 'S', 2`, 'notification_template_version_email_subject'],
    ])('refuses %s', async (_l, values, constraint) => {
      expect(await failure(url,
        `INSERT INTO notification_template_version ("templateId", locale, version, variables, "bodyText", checksum, channel, subject, "smsMaxSegments") VALUES ($1,'en',50,'{}','B',$2, ${values})`,
        [CODE_TEMPLATE, 'c'.repeat(64)])).toMatchObject({ code: '23514', constraint });
    });

    it('a template\'s identity and category never change; one platform template per key', async () => {
      expect(await failure(url, `UPDATE notification_template SET category = 'OPTIONAL' WHERE id = $1`, [CODE_TEMPLATE])).toMatchObject({ code: '23514' });
      expect(await failure(url, `INSERT INTO notification_template (key, category, description) VALUES ('identity.contact_verification_code', 'SECURITY', 'd')`)).toMatchObject({ code: '23505', constraint: 'notification_template_platform_key_unique' });
    });
  });
});

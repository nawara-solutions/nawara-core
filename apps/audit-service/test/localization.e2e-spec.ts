import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type ServiceTokenEntry } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { AuditRecordRepository } from '../src/persistence/audit-record.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * ADR-0054 (Core V1 refactor R6.1): Audit's own error messages in en / fr / ar. Status, `code`, `error` and the ids never change with
 * the language; English without Accept-Language is the pre-R6.1 text; code-less errors stay code-less; success bodies, audit action names
 * and the persisted evidence never change with the language; nothing a client sent leaks.
 */
const ORG = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const WINDOW = { from: '2026-05-01T00:00:00Z', to: '2026-06-30T00:00:00Z' };
const PWINDOW = { from: '2026-05-25T00:00:00Z', to: '2026-06-20T00:00:00Z' };
const caller = (name: string) => {
  const { token, digest } = generateServiceToken();
  return { name, token, entry: { caller: name, digest } as ServiceTokenEntry };
};
const ORG_READER = caller('org-reader');
const SEC_READER = caller('sec-reader');
const PLATFORM_READER = caller('platform-reader');
const ALL = ['security', 'business', 'commercial', 'administrative'];
const POLICY = JSON.stringify({
  callers: {
    [ORG_READER.name]: { operations: ['read_organization'], categories: ALL },
    [SEC_READER.name]: { operations: ['read_organization'], categories: ['security'] },
    [PLATFORM_READER.name]: { operations: ['read_platform'], categories: ALL },
  },
});
const SENTINELS = ['DO_NOT_LEAK', 'Bearer FAKE_AUDIT_SECRET', 'FAKE_AUDIT_SECRET', 'db.internal.example', '/srv/private/audit-secret'];
// [Accept-Language, expected Content-Language]
const NEGOTIATION: [string | undefined, 'en' | 'fr' | 'ar'][] = [
  [undefined, 'en'], ['en', 'en'], ['fr', 'fr'], ['ar', 'ar'], ['fr-FR', 'fr'], ['ar-TN', 'ar'], ['de-DE', 'en'], [';;q=x', 'en'],
];

describeWithEnv('Audit error localization over real HTTP (R6.1)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const get = (path: string, who: { token: string } | undefined, query: Record<string, string | string[]>, lang?: string) => {
    let r = request(t.app.getHttpServer()).get(path).query(query).set('x-correlation-id', 'corr-r61-0001');
    if (who) r = r.set('authorization', `Bearer ${who.token}`);
    return lang === undefined ? r : r.set('accept-language', lang);
  };
  const org = (who: { token: string } | undefined, query: Record<string, string | string[]>, lang?: string) => get(`/audit/organizations/${ORG}/records`, who, query, lang);

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL!, 'al10n');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    t = await createTestApp({ databaseUrl: d.appUrl, tokens: [ORG_READER.entry, SEC_READER.entry, PLATFORM_READER.entry], policy: POLICY });
    const seeded = await t.app.get(AuditRecordRepository).insertOnce({
      eventId: randomUUID(), sourceService: 'auth-service', action: 'membership.revoked', category: 'business', schemaVersion: 1,
      actor: { type: 'user', id: 'a1a1a1a1-0000-4000-8000-00000000000a', userKind: 'owner' }, resource: { type: 'membership', id: randomUUID() },
      subject: { type: 'user', id: 'a1a1a1a1-0000-4000-8000-00000000000a' }, outcome: 'succeeded', changes: { authority: 'owner', was_admin: false },
      correlationId: 'corr-seed-0001', causationId: null, occurredAt: new Date('2026-06-01T00:00:00Z'), organizationId: ORG,
    } as never);
    expect(seeded.kind).toBe('inserted');
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });

  it.each(NEGOTIATION)('query grammar (%s): code, status, error and ids identical; message and Content-Language follow the language', async (l, used) => {
    const r = await org(ORG_READER, {}, l);
    const message = { en: 'from and to are required', fr: 'from et to sont obligatoires', ar: 'المعاملان from وto مطلوبان' }[used];
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ statusCode: 400, message, error: 'Bad Request', code: 'invalid_query', requestId: r.headers['x-request-id'] });
    expect(r.headers['content-language']).toBe(used);
    expect(r.headers.vary).toMatch(/Accept-Language/);
    expect(r.headers['x-correlation-id']).toBe('corr-r61-0001');
  });

  it('parameterized messages keep the API parameter names and the configured bounds in every language', async () => {
    const en = await org(ORG_READER, { ...WINDOW, limit: '99999' }).expect(400);
    const max = /from 1 to (\d+)$/.exec(en.body.message)![1];
    expect(en.body.message).toBe(`limit must be an integer from 1 to ${max}`);
    expect((await org(ORG_READER, { ...WINDOW, limit: '99999' }, 'fr').expect(400)).body.message).toBe(`limit doit être un entier de 1 à ${max}`);
    expect((await org(ORG_READER, { ...WINDOW, limit: '99999' }, 'ar').expect(400)).body.message).toBe(`يجب أن يكون limit عددًا صحيحًا من 1 إلى ${max}`);
    const twice = await org(ORG_READER, { ...WINDOW, from: [WINDOW.from, WINDOW.from] }, 'fr').expect(400);
    expect(twice.body).toMatchObject({ code: 'invalid_query', message: 'from doit être fourni une seule fois' });
    const wide = await org(ORG_READER, { from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }, 'ar').expect(400);
    expect(wide.body.code).toBe('window_too_large');
    expect(wide.body.message).toMatch(/^لا يجوز أن تتجاوز النافذة الزمنية \d+ يومًا$/);
  });

  it('policy refusals (403) keep their codes; the message follows the language', async () => {
    const cat = await org(SEC_READER, { ...WINDOW, category: 'business' }, 'fr').expect(403);
    expect(cat.body).toEqual({ statusCode: 403, message: 'Cet appelant ne peut pas consulter cette catégorie.', error: 'Forbidden', code: 'category_not_allowed', requestId: cat.headers['x-request-id'] });
    const op = await org(PLATFORM_READER, WINDOW, 'ar').expect(403);
    expect(op.body).toMatchObject({ code: 'operation_not_allowed', message: 'العملية غير مسموح بها لهذا المستدعي.' });
  });

  it('a code-less 401 (the kit guard) stays code-less; only its generic text is localized; a bearer is never echoed', async () => {
    for (const [l, text] of [['en', 'Unauthorized'], ['fr', 'Authentification requise'], ['ar', 'المصادقة مطلوبة']]) {
      const r = await org({ token: 'FAKE_AUDIT_SECRET' }, WINDOW, l).expect(401);
      expect(r.body).toEqual({ statusCode: 401, message: text, error: 'Unauthorized', requestId: r.headers['x-request-id'] });
      expect(r.body).not.toHaveProperty('code');
      for (const s of SENTINELS) expect(r.text + JSON.stringify(r.headers)).not.toContain(s);
    }
  });

  it('a read with a body is refused in the language asked', async () => {
    const r = await request(t.app.getHttpServer()).get(`/audit/organizations/${ORG}/records`).query(WINDOW)
      .set('authorization', `Bearer ${ORG_READER.token}`).set('accept-language', 'fr').set('content-type', 'application/json').send('{"x":1}').expect(400);
    expect(r.body).toMatchObject({ code: 'unexpected_body', message: "Une lecture n'accepte pas de corps de requête." });
  });

  it.each(['en', 'fr', 'ar'])('%s: sentinel parameter names and values are never echoed', async (l) => {
    const unknown = await org(ORG_READER, { ...WINDOW, DO_NOT_LEAK: '/srv/private/audit-secret' }, l).expect(400);
    const badValue = await org(ORG_READER, { ...WINDOW, correlationId: 'db.internal.example password=DO_NOT_LEAK' }, l).expect(400);
    for (const r of [unknown, badValue]) for (const s of SENTINELS) expect(r.text + JSON.stringify(r.headers)).not.toContain(s);
    expect(unknown.body.code).toBe('invalid_query');
  });

  it('success bodies and audit action names never change with the language; no language header on success', async () => {
    const en = await org(ORG_READER, WINDOW).expect(200);
    const fr = await org(ORG_READER, WINDOW, 'fr').expect(200);
    const ar = await org(ORG_READER, WINDOW, 'ar').expect(200);
    expect(en.body.items.length).toBeGreaterThan(0);
    expect(fr.body).toEqual(en.body);
    expect(ar.body).toEqual(en.body);
    expect(fr.body.items[0].action).toBe('membership.revoked');
    expect(fr.headers['content-language']).toBeUndefined();
  });

  it('the persisted accountability evidence of a platform read never carries localized text', async () => {
    await get('/audit/platform/records', PLATFORM_READER, PWINDOW, 'fr').expect(200);
    await get('/audit/platform/records', PLATFORM_READER, { ...PWINDOW, limit: '99999' }, 'ar').expect(400);
    const rows = await sql<{ action: string; doc: string }>(d.adminUrl, `SELECT action, row_to_json(a)::text AS doc FROM audit_record a WHERE action = 'platform_query.executed'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.action).toBe('platform_query.executed');
      expect(r.doc).not.toMatch(/[؀-ۿ]|é|à|doit/);
    }
  });
});

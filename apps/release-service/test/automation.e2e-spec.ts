import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import { deterministicEventId } from '../src/audit/release-audit.js';
import { ReleaseStore } from '../src/persistence/release-store.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

type Row = Record<string, any>;

/**
 * Stage 20.3 (ADR-0051 §8, §9, §11): CI registration and publication through the REAL application (the module graph main.ts ships), on
 * a database provisioned as production (`release_app`, the least-privilege runtime role): service authentication, the per-product
 * policy, idempotency, the lifecycle, concurrency, and the audit intent in the same transaction.
 */
describeWithEnv('release-service automation API (Stage 20.3) — real PostgreSQL, runtime role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const tok = {
    ci: generateServiceToken(), // drive: register + publish; race-*: register (fresh products for the concurrency cases)
    reg: generateServiceToken(), // drive: register only
    pub: generateServiceToken(), // drive: publish only
    other: generateServiceToken(), // daycare: register + publish (another product's automation)
  };
  const POLICY = {
    callers: {
      'drive-ci': { products: { drive: ['release.register', 'release.publish'], 'race-a': ['release.register', 'release.publish'], 'race-b': ['release.register'] } },
      'drive-register': { products: { drive: ['release.register'] } },
      'drive-publish': { products: { drive: ['release.publish'] } },
      'daycare-ci': { products: { daycare: ['release.register', 'release.publish'] } },
    },
  };
  const server = () => t.app.getHttpServer();
  const bearer = (x: { token: string }) => ({ authorization: `Bearer ${x.token}` });
  let n = 0;
  const key = (p = 'comp') => `${p}-${n++}`;
  const regPath = (product: string, component: string) => `/release/products/${product}/components/${component}/releases`;
  const pubPath = (product: string, component: string, version: string) => `${regPath(product, component)}/${version}/publish`;
  const register = (component: string, body: Row, who = tok.ci, product = 'drive', headers: Record<string, string> = {}) =>
    request(server()).post(regPath(product, component)).set({ ...bearer(who), ...headers }).send(body);
  const publish = (component: string, version: string, who = tok.ci, product = 'drive', headers: Record<string, string> = {}) =>
    request(server()).post(pubPath(product, component, version)).set({ ...bearer(who), ...headers });
  const releases = (where = 'true', params: unknown[] = []) =>
    sql<Row>(d.adminUrl, `SELECT r.*, c.key AS component, c.kind, c."productId", p.key AS product FROM release r JOIN component c ON c.id = r."componentId" JOIN product p ON p.id = c."productId" WHERE ${where}`, params);
  const audits = (releaseId: string) =>
    sql<Row>(d.adminUrl, `SELECT id, name, payload, "correlationId" FROM outbox WHERE payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [releaseId]);
  const counts = async () => (await sql<Row>(d.adminUrl, `SELECT (SELECT count(*)::int FROM product) p, (SELECT count(*)::int FROM component) c, (SELECT count(*)::int FROM release) r, (SELECT count(*)::int FROM outbox) o`))[0]!;
  const refuseOutbox = (name: string) =>
    sql(d.adminUrl, `CREATE OR REPLACE FUNCTION s203_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox refused (test)'; END $$;
                     CREATE TRIGGER s203_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name = '${name}') EXECUTE FUNCTION s203_refuse()`);

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'relauto');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl,
      env: {
        SERVICE_TOKENS: [['drive-ci', tok.ci], ['drive-register', tok.reg], ['drive-publish', tok.pub], ['daycare-ci', tok.other]].map(([c, x]) => `${c as string}:${(x as { digest: string }).digest}`).join(','),
        RELEASE_SERVICE_POLICY: JSON.stringify(POLICY),
      },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });
  afterEach(async () => {
    await sql(d.adminUrl, 'DROP TRIGGER IF EXISTS s203_refuse ON outbox');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── authentication
  describe('authentication (ADR-0033): a service token, nothing else', () => {
    /** An HS256 JWT shaped like a human session of each kind, with every broad claim a confused guard might honour. */
    const humanJwt = (kind: string, exp = Math.floor(Date.now() / 1000) + 600) => {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: randomUUID(), kind, role: 'admin', scope: 'release.register release.publish', products: ['drive'], iss: 'auth-service', aud: 'release-service', exp })}`;
      return `${body}.${createHmac('sha256', 'k').update(body).digest('base64url')}`;
    };

    it.each([
      ['no Authorization header', {}],
      ['an empty bearer', { authorization: 'Bearer ' }],
      ['a malformed scheme', { authorization: `Basic ${Buffer.from('drive-ci:x').toString('base64')}` }],
      ['two tokens', { authorization: `Bearer ${tok.ci.token} ${tok.ci.token}` }],
      ['a token registered nowhere here (another callee\'s credential: audience by construction)', { authorization: `Bearer ${generateServiceToken().token}` }],
      ['a digest instead of the token', { authorization: `Bearer ${tok.ci.digest}` }],
      ['a human OWNER session token (a JWT with broad claims)', { authorization: `Bearer ${humanJwt('owner')}` }],
      ['a human OPERATOR session token', { authorization: `Bearer ${humanJwt('operator')}` }],
      ['a human MEMBER session token', { authorization: `Bearer ${humanJwt('member')}` }],
      ['an EXPIRED human token', { authorization: `Bearer ${humanJwt('owner', 1)}` }],
      ['identity headers and no token', { 'x-service': 'drive-ci', 'x-product': 'drive', 'x-role': 'owner', 'x-owner': 'true', 'x-permissions': 'release.register', 'x-caller': 'drive-ci' }],
    ])('%s: the same generic 401 on both operations, nothing written, nothing echoed', async (_name, headers) => {
      const before = await counts();
      for (const r of [
        await request(server()).post(regPath('drive', 'authn')).set(headers as Record<string, string>).send({ kind: 'web', version: '1.0.0' }),
        await request(server()).post(pubPath('drive', 'authn', '1.0.0')).set(headers as Record<string, string>),
      ]) {
        expect(r.status).toBe(401);
        expect(r.body).toMatchObject({ statusCode: 401, message: 'Unauthorized' });
        expect(r.body.code).toBeUndefined();
        expect(JSON.stringify(r.body)).not.toMatch(/drive|token|digest|owner|expired|jwt/i);
      }
      expect(await counts()).toEqual(before);
    });

    it('a token never reaches the logs, in success or refusal', async () => {
      await register(key(), { kind: 'web', version: '1.0.0' });
      await register(key(), { kind: 'web', version: '1.0.0' }, tok.other);
      await request(server()).post(regPath('drive', 'x')).set({ authorization: 'Bearer not-a-real-token-value-123' });
      const all = JSON.stringify(t.logs);
      for (const x of Object.values(tok)) {
        expect(all).not.toContain(x.token);
        expect(all).not.toContain(x.digest);
      }
      expect(all).not.toContain('not-a-real-token-value-123');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── authorization
  describe('authorization (ADR-0042, ADR-0051 §8): per caller, per product, per capability; deny by default', () => {
    const cases = [
      // caller, product, register, publish
      ['drive-ci (register + publish on drive)', tok.ci, 'drive', 'allow', 'allow'],
      ['drive-register (register only)', tok.reg, 'drive', 'allow', 'operation_not_allowed'],
      ['drive-publish (publish only)', tok.pub, 'drive', 'operation_not_allowed', 'allow'],
      ['daycare-ci on drive (another product\'s automation)', tok.other, 'drive', 'product_not_allowed', 'product_not_allowed'],
      ['drive-ci on daycare', tok.ci, 'daycare', 'product_not_allowed', 'product_not_allowed'],
      ['drive-ci on race-b (register only there)', tok.ci, 'race-b', 'allow', 'product_not_allowed'],
    ] as const;

    it.each(cases)('%s', async (_name, who, product, reg, pub) => {
      // a release to publish exists in the product, registered by a caller that may
      const component = key();
      const seeder = product === 'daycare' ? tok.other : tok.ci;
      if (product !== 'race-b') expect((await register(component, { kind: 'desktop', version: '1.0.0' }, seeder, product)).status).toBe(201);

      const before = await counts();
      const r = await register(component, { kind: 'desktop', version: '2.0.0' }, who, product);
      if (reg === 'allow') expect(r.status).toBe(201);
      else {
        expect([r.status, r.body.code]).toEqual([403, reg]);
        expect(await counts()).toEqual(before); // nothing written, no evidence
      }
      const before2 = await counts();
      const p = await publish(component, '1.0.0', who, product);
      if (pub === 'allow') expect(p.status).toBe(200);
      else {
        expect([p.status, p.body.code]).toEqual([403, pub]);
        expect(await counts()).toEqual(before2);
      }
    });

    it('an unknown product and a forbidden existing one are the same answer (no enumeration); authorization comes before validation and lookup', async () => {
      expect((await register(key(), { kind: 'web', version: '1.0.0' }, tok.other, 'daycare')).status).toBe(201); // daycare now exists
      const strip = (b: Row) => ({ ...b, requestId: undefined });
      const existing = await register('x', { kind: 'web', version: '1.0.0' }, tok.ci, 'daycare');
      const unknown = await register('x', { kind: 'web', version: '1.0.0' }, tok.ci, 'no-such-product');
      const malformed = await register('x', { kind: 'web', version: '1.0.0' }, tok.ci, 'Not_A_Key');
      expect(strip(existing.body)).toEqual(strip(unknown.body));
      expect(strip(malformed.body)).toEqual(strip(unknown.body));
      expect(existing.status).toBe(403);
      // a forbidden caller sending garbage still gets 403, never a validation hint
      const garbage = await register('BAD KEY', { environment: 'prod', version: 'v1' }, tok.ci, 'daycare');
      expect([garbage.status, garbage.body.code]).toEqual([403, 'product_not_allowed']);
      const pubGarbage = await publish('BAD', 'v1', tok.reg, 'drive');
      expect([pubGarbage.status, pubGarbage.body.code]).toEqual([403, 'operation_not_allowed']);
      // publish on a product with no authority, for a release that does not exist vs one that does: identical
      const c = key();
      await register(c, { kind: 'web', version: '1.0.0' }, tok.other, 'daycare');
      expect(strip((await publish(c, '1.0.0', tok.ci, 'daycare')).body)).toEqual(strip((await publish('nothing', '9.9.9', tok.ci, 'daycare')).body));
    });

    it('caller-supplied identity or authority headers never widen the policy', async () => {
      const component = key();
      await register(component, { kind: 'web', version: '1.0.0' });
      const forged = { 'x-service': 'drive-ci', 'x-caller': 'drive-ci', 'x-product': 'drive', 'x-role': 'owner', 'x-owner': 'true', 'x-permissions': 'release.publish', 'x-operator': 'true' };
      const p = await publish(component, '1.0.0', tok.reg, 'drive', forged);
      expect([p.status, p.body.code]).toEqual([403, 'operation_not_allowed']);
      const r = await register(key(), { kind: 'web', version: '1.0.0' }, tok.other, 'drive', { ...forged, 'x-product': 'daycare' });
      expect([r.status, r.body.code]).toEqual([403, 'product_not_allowed']);
      expect(t.logs.some((l) => String(l.msg) === 'release_authorization_denied caller=drive-register capability=release.publish reason=operation_not_allowed')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── registration
  describe('registration', () => {
    it('201: a new release, `registered`, with exactly the declared identity; the component is created with its kind; no-store', async () => {
      const component = key('mobile-app');
      const r = await register(component, { kind: 'mobile_ios', version: '1.4.0', buildId: '1400', sourceRevision: 'a1b2c3d4e5f6', notesRef: 'https://notes.example/1.4.0' });
      expect(r.status).toBe(201);
      expect(r.headers['idempotent-replayed']).toBeUndefined();
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).toEqual({
        id: expect.any(String), product: 'drive', component, kind: 'mobile_ios', version: '1.4.0', buildId: '1400', sourceRevision: 'a1b2c3d4e5f6',
        notesRef: 'https://notes.example/1.4.0', status: 'registered', registeredAt: expect.any(String), publishedAt: null, withdrawnAt: null,
      });
      const [row] = await releases('r.id = $1', [r.body.id]);
      expect(row).toMatchObject({ product: 'drive', component, kind: 'mobile_ios', version: '1.4.0', buildId: '1400', status: 'registered', publishedAt: null });
      const optional = await register(key(), { kind: 'backend', version: '0.1.0-alpha.1', buildId: null, sourceRevision: null, notesRef: null });
      expect([optional.status, optional.body.buildId, optional.body.status]).toEqual([201, null, 'registered']);
    });

    it('the same registration again is idempotent: 200 + Idempotent-Replayed, the same release, one row, ONE audit record — in any later status too', async () => {
      const component = key();
      const body = { kind: 'web', version: '3.1.0', buildId: 'b-77', sourceRevision: 'abcdef0' };
      const first = await register(component, body);
      expect(first.status).toBe(201);
      for (let i = 0; i < 3; i++) {
        const again = await register(component, body);
        expect([again.status, again.headers['idempotent-replayed'], again.body.id, again.body.registeredAt]).toEqual([200, 'true', first.body.id, first.body.registeredAt]);
      }
      expect((await publish(component, '3.1.0')).status).toBe(200);
      const later = await register(component, body);
      expect([later.status, later.body.status]).toEqual([200, 'published']); // reports, never regresses the lifecycle
      expect(await releases('c.key = $1', [component])).toHaveLength(1);
      expect((await audits(first.body.id)).map((a) => a.name)).toEqual(['audit.release.registered', 'audit.release.published']);
    });

    it('conflicting immutable metadata for an existing version is 409 release_conflict and never overwrites (no last-write-wins)', async () => {
      const component = key();
      const first = await register(component, { kind: 'desktop', version: '2.0.0', buildId: '200', sourceRevision: 'abcdef1' });
      for (const change of [{ buildId: '201' }, { buildId: null }, { sourceRevision: 'abcdef2' }, { notesRef: 'x' }]) {
        const r = await register(component, { kind: 'desktop', version: '2.0.0', buildId: '200', sourceRevision: 'abcdef1', ...change });
        expect([r.status, r.body.code], JSON.stringify(change)).toEqual([409, 'release_conflict']);
      }
      const [row] = await releases('r.id = $1', [first.body.id]);
      expect(row).toMatchObject({ buildId: '200', sourceRevision: 'abcdef1', notesRef: null });
      expect(await audits(first.body.id)).toHaveLength(1);
    });

    it('a component keeps its kind: another kind for it is 409 component_kind_conflict, and nothing is written', async () => {
      const component = key();
      await register(component, { kind: 'mobile_android', version: '1.0.0' });
      const before = await counts();
      const r = await register(component, { kind: 'mobile_ios', version: '1.1.0' });
      expect([r.status, r.body.code]).toEqual([409, 'component_kind_conflict']);
      expect(await counts()).toEqual(before);
    });

    it.each([
      ['a leading v', { kind: 'web', version: 'v1.0.0' }],
      ['two parts', { kind: 'web', version: '1.0' }],
      ['build metadata (would silently become another identity)', { kind: 'web', version: '1.0.0+7' }],
      ['a leading zero', { kind: 'web', version: '01.0.0' }],
      ['a numeric pre-release leading zero', { kind: 'web', version: '1.0.0-01' }],
      ['16 digits', { kind: 'web', version: '1234567890123456.0.0' }],
      ['over 128 characters', { kind: 'web', version: `1.0.0-${'a'.repeat(123)}` }],
      ['whitespace', { kind: 'web', version: ' 1.0.0' }],
      ['a number', { kind: 'web', version: 1 }],
      ['no version', { kind: 'web' }],
      ['no kind', { version: '1.0.0' }],
      ['a technology as a kind', { kind: 'tauri', version: '1.0.0' }],
      ['the reserved ai kind', { kind: 'ai', version: '1.0.0' }],
      ['a build id with a space', { kind: 'web', version: '1.0.0', buildId: 'build 7' }],
      ['a 129-character build id', { kind: 'web', version: '1.0.0', buildId: 'b'.repeat(129) }],
      ['an upper-case revision', { kind: 'web', version: '1.0.0', sourceRevision: 'ABCDEF1' }],
      ['a short revision', { kind: 'web', version: '1.0.0', sourceRevision: 'abc' }],
      ['a 513-character notes ref', { kind: 'web', version: '1.0.0', notesRef: 'n'.repeat(513) }],
      ['a status (no lifecycle bypass)', { kind: 'web', version: '1.0.0', status: 'published' }],
      ['a publication time', { kind: 'web', version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z' }],
      ['an environment', { kind: 'web', version: '1.0.0', environment: 'production' }],
      ['a channel', { kind: 'web', version: '1.0.0', channel: 'beta' }],
      ['an artifact', { kind: 'web', version: '1.0.0', artifactUrl: 'https://cdn/x.zip' }],
      ['a signing key', { kind: 'web', version: '1.0.0', signingKey: 'k' }],
      ['an organization', { kind: 'web', version: '1.0.0', organizationId: randomUUID() }],
      ['a user', { kind: 'web', version: '1.0.0', userId: randomUUID() }],
      ['a feature flag', { kind: 'web', version: '1.0.0', featureFlags: { a: true } }],
      ['a maintenance setting', { kind: 'web', version: '1.0.0', maintenance: true }],
      ['a minimum version (20.4)', { kind: 'web', version: '1.0.0', minimumVersion: '1.0.0' }],
    ])('400 for %s; nothing written', async (_name, body) => {
      const before = await counts();
      const r = await register(key(), body as Row);
      expect(r.status).toBe(400);
      expect(await counts()).toEqual(before);
    });

    it('400 validation_error for a malformed component key (the product was authorized first)', async () => {
      for (const component of ['Bad', 'a_b', '-x', 'x'.repeat(64)]) {
        const r = await register(component, { kind: 'web', version: '1.0.0' });
        expect([r.status, r.body.code], component).toEqual([400, 'validation_error']);
      }
    });

    it('concurrency: 8 identical registrations of a NEW product, component and version → one release, one 201, seven 200, ONE audit record', async () => {
      const component = key();
      const rs = await Promise.all(Array.from({ length: 8 }, () => register(component, { kind: 'mobile_android', version: '5.0.0', buildId: '500' }, tok.ci, 'race-a')));
      expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
      expect(await releases('c.key = $1', [component])).toHaveLength(1);
      expect((await sql<Row>(d.adminUrl, `SELECT count(*)::int n FROM product WHERE key = 'race-a'`))[0]!.n).toBe(1);
      expect(await audits(rs[0]!.body.id)).toHaveLength(1);
    });

    it('concurrency: 8 DIFFERENT versions of a new component in a new product → 8 releases, one component, one product, 8 audit records', async () => {
      const component = key();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => register(component, { kind: 'web', version: `1.${i}.0` }, tok.ci, 'race-b')));
      expect(rs.map((r) => r.status)).toEqual(Array(8).fill(201));
      expect((await sql<Row>(d.adminUrl, `SELECT count(*)::int n FROM component c JOIN product p ON p.id = c."productId" WHERE p.key = 'race-b' AND c.key = $1`, [component]))[0]!.n).toBe(1);
      for (const r of rs) expect(await audits(r.body.id)).toHaveLength(1);
    });

    it('concurrency: identical registrations racing a CONFLICTING one → exactly one identity wins; the losers are 409 and nothing is overwritten', async () => {
      const component = key();
      const rs = await Promise.all([...Array.from({ length: 4 }, () => register(component, { kind: 'web', version: '6.0.0', buildId: 'A' })), ...Array.from({ length: 4 }, () => register(component, { kind: 'web', version: '6.0.0', buildId: 'B' }))]);
      const [row] = await releases('c.key = $1', [component]);
      const winner = row!.buildId as string;
      for (const [i, r] of rs.entries()) {
        const mine = i < 4 ? 'A' : 'B';
        if (mine === winner) expect([200, 201]).toContain(r.status);
        else expect([r.status, r.body.code]).toEqual([409, 'release_conflict']);
      }
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await audits(row!.id as string)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── publication
  describe('publication', () => {
    it('registered → published: 200, publishedAt set, one release.published record; a retry is 200 + Idempotent-Replayed with the same publishedAt and no new record', async () => {
      const component = key();
      const reg = await register(component, { kind: 'desktop', version: '2.3.0' });
      const p = await publish(component, '2.3.0');
      expect(p.status).toBe(200);
      expect(p.headers['idempotent-replayed']).toBeUndefined();
      expect(p.headers['cache-control']).toBe('no-store');
      expect(p.body).toMatchObject({ id: reg.body.id, status: 'published', publishedAt: expect.any(String), withdrawnAt: null });
      for (let i = 0; i < 3; i++) {
        const again = await publish(component, '2.3.0');
        expect([again.status, again.headers['idempotent-replayed'], again.body.publishedAt]).toEqual([200, 'true', p.body.publishedAt]);
      }
      expect((await audits(reg.body.id)).map((a) => a.name)).toEqual(['audit.release.registered', 'audit.release.published']);
    });

    it('a pre-release version in the path is published by its exact identity', async () => {
      const component = key();
      await register(component, { kind: 'web', version: '2.0.0-rc.1' });
      await register(component, { kind: 'web', version: '2.0.0' });
      expect((await publish(component, '2.0.0-rc.1')).body).toMatchObject({ version: '2.0.0-rc.1', status: 'published' });
      expect((await releases('c.key = $1 AND version = $2', [component, '2.0.0']))[0]!.status).toBe('registered');
    });

    it('concurrency: 8 simultaneous publications → one transition, one publishedAt, ONE release.published record; all answer 200', async () => {
      const component = key();
      const reg = await register(component, { kind: 'mobile_ios', version: '7.0.0' });
      const rs = await Promise.all(Array.from({ length: 8 }, () => publish(component, '7.0.0')));
      expect(rs.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(rs.filter((r) => r.headers['idempotent-replayed'] === undefined)).toHaveLength(1);
      expect(new Set(rs.map((r) => r.body.publishedAt)).size).toBe(1);
      expect((await audits(reg.body.id)).filter((a) => a.name === 'audit.release.published')).toHaveLength(1);
    });

    it('a withdrawn release is never republished (409 invalid_transition; the retry rule is not a lifecycle bypass); there is no withdrawal route', async () => {
      const component = key();
      const reg = await register(component, { kind: 'web', version: '1.0.0' });
      await publish(component, '1.0.0');
      await t.app.get(ReleaseStore).withdrawRelease(reg.body.id); // Stage 20.4 will own this move (the verified owner); the primitive exists
      const r = await publish(component, '1.0.0');
      expect([r.status, r.body.code]).toEqual([409, 'invalid_transition']);
      expect((await releases('r.id = $1', [reg.body.id]))[0]!.status).toBe('withdrawn');
      expect((await audits(reg.body.id)).map((a) => a.name)).toEqual(['audit.release.registered', 'audit.release.published']);
      for (const [m, path] of [['post', `${regPath('drive', component)}/1.0.0/withdraw`], ['delete', `${regPath('drive', component)}/1.0.0`], ['get', regPath('drive', component)],
        ['get', `${regPath('drive', component)}/1.0.0`], ['put', `${regPath('drive', component)}/1.0.0`], ['post', `/release/products/drive/components/${component}/policy`]] as const) {
        expect((await request(server())[m](path).set(bearer(tok.ci))).status, `${m} ${path}`).toBe(404);
      }
    });

    it('404 release_not_found for an unknown component or version (in an authorized product); 400 for a malformed one', async () => {
      const component = key();
      await register(component, { kind: 'web', version: '1.0.0' });
      for (const [c, v] of [[component, '1.0.1'], ['no-such-component', '1.0.0'], [component, '1.0.0-rc.1']]) {
        const r = await publish(c!, v!);
        expect([r.status, r.body.code], `${c} ${v}`).toEqual([404, 'release_not_found']);
      }
      for (const [c, v] of [[component, 'v1.0.0'], [component, '1.0.0+1'], [component, '1.0'], ['Bad', '1.0.0']]) {
        const r = await publish(c!, encodeURIComponent(v!));
        expect([r.status, r.body.code], `${c} ${v}`).toEqual([400, 'validation_error']);
      }
    });

    it('publishing never registers: nothing is created for an unknown release', async () => {
      const before = await counts();
      expect((await publish(key(), '1.0.0')).status).toBe(404);
      expect(await counts()).toEqual(before);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── audit / outbox
  describe('audit intent (ADR-0049, ADR-0051 §9): in the mutation transaction, truthful, bounded', () => {
    it('release.registered / release.published: the CI service as actor, platform-level, the release as resource, identifiers only; catalog-valid; the correlation id kept', async () => {
      const component = key();
      const reg = await register(component, { kind: 'mobile_android', version: '4.2.0', buildId: 'SECRET-BUILD-42', sourceRevision: 'deadbeefcafe', notesRef: 'https://private.example/notes' },
        tok.ci, 'drive', { 'x-correlation-id': 'ci-pipeline-run-0001', 'x-request-id': 'req-0001-abcdef' });
      await publish(component, '4.2.0', tok.ci, 'drive', { 'x-correlation-id': 'ci-pipeline-run-0002' });
      const [row] = await releases('r.id = $1', [reg.body.id]);
      const rows = await audits(reg.body.id);
      expect(rows.map((r) => [r.id, r.name, r.correlationId])).toEqual([
        [deterministicEventId(reg.body.id, 'audit.release.registered'), 'audit.release.registered', 'ci-pipeline-run-0001'],
        [deterministicEventId(reg.body.id, 'audit.release.published'), 'audit.release.published', 'ci-pipeline-run-0002'],
      ]);
      for (const [i, action] of (['release.registered', 'release.published'] as const).entries()) {
        const payload = rows[i]!.payload;
        expect(payload).toEqual({
          action, actor: { type: 'service', id: 'drive-ci' }, organizationId: null, resource: { type: 'release', id: reg.body.id }, outcome: 'succeeded',
          changes: { product_id: row!.productId, component_id: row!.componentId, kind: 'mobile_android' },
        });
        expect(() => validateAuditPayload(payload, 'release-service')).not.toThrow();
        expect(() => validateAuditPayload(payload, 'file-service')).toThrow('producer_not_admitted');
        const text = JSON.stringify(payload);
        for (const secret of ['4.2.0', 'SECRET-BUILD-42', 'deadbeefcafe', 'private.example', 'drive"', component, tok.ci.token, tok.ci.digest, 'authorization', 'Bearer']) {
          expect(text, secret).not.toContain(secret);
        }
      }
    });

    it('an unsafe correlation header never reaches the evidence as given (the kit bounds it and falls back to the request id)', async () => {
      const component = key();
      const reg = await register(component, { kind: 'web', version: '1.0.0' }, tok.ci, 'drive', { 'x-correlation-id': 'bad correlation <script>' });
      const [a] = await audits(reg.body.id);
      expect(a!.correlationId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
      expect(a!.correlationId).toBe(reg.headers['x-request-id']);
    });

    it('atomicity (registration): when the audit intent cannot be written, NOTHING commits (no release, no component, no product row added); the retry then writes once', async () => {
      const component = key();
      await refuseOutbox('audit.release.registered');
      const before = await counts();
      const r = await register(component, { kind: 'web', version: '9.0.0' });
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/outbox|refused|trigger|sql|stack/i);
      expect(await counts()).toEqual(before);
      await sql(d.adminUrl, 'DROP TRIGGER s203_refuse ON outbox');
      const retry = await register(component, { kind: 'web', version: '9.0.0' });
      expect(retry.status).toBe(201);
      expect(await audits(retry.body.id)).toHaveLength(1);
    });

    it('atomicity (publication): when the audit intent cannot be written, the release stays `registered`; the retry publishes and writes once', async () => {
      const component = key();
      const reg = await register(component, { kind: 'web', version: '9.1.0' });
      await refuseOutbox('audit.release.published');
      expect((await publish(component, '9.1.0')).status).toBe(500);
      expect((await releases('r.id = $1', [reg.body.id]))[0]).toMatchObject({ status: 'registered', publishedAt: null });
      await sql(d.adminUrl, 'DROP TRIGGER s203_refuse ON outbox');
      const p = await publish(component, '9.1.0');
      expect([p.status, p.headers['idempotent-replayed']]).toEqual([200, undefined]);
      expect((await audits(reg.body.id)).map((a) => a.name)).toEqual(['audit.release.registered', 'audit.release.published']);
      expect(t.logs.some((l) => String(l.msg).startsWith('release_automation_failed operation=publish caller=drive-ci error='))).toBe(true);
    });

    it('only audit intent is produced: every outbox row is a catalog-valid release action (no domain events, no notification, no billing)', async () => {
      const rows = await sql<Row>(d.adminUrl, 'SELECT name, payload FROM outbox');
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(['audit.release.registered', 'audit.release.published']).toContain(r.name);
        expect(() => validateAuditPayload(r.payload, 'release-service')).not.toThrow();
      }
    });
  });
});

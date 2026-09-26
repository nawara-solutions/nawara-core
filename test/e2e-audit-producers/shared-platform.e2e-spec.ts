import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, PROHIBITED, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 21 (Shared Services Integration): the shared platform as ONE system, all real — Auth, audit-service, File, Notification and
 * Release, each from its own built dist as its own process on its own database, one real RabbitMQ behind a severable TCP proxy.
 *
 * Proves across service boundaries (not per service):
 * - the three integration shapes: a human security action (own bearer → Auth → step-up → mutation → outbox → Audit), service automation
 *   (service token → policy → mutation → outbox → Audit), a public read (no identity, no Audit);
 * - credential confusion: every credential is refused everywhere it does not belong; forged identity headers and correlation ids are
 *   never identity; a step-up proof for one service's purpose is refused by another service's operation;
 * - failure isolation: Auth, the broker, audit-service, Notification, File and Release each go down in turn; what depends on them
 *   degrades as designed, everything else stays ready and working, and no audit evidence is lost.
 */
const PORT = { audit: 3901, auth: 3902, file: 3903, notification: 3904, release: 3905 };
const url = (s: keyof typeof PORT) => `http://127.0.0.1:${PORT[s]}`;
const AUTH_DIR = `${APPS}auth-service`;
const b64 = () => randomBytes(32).toString('base64');
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(500, 0x20), Buffer.from('\n%%EOF\n')]);

function totp(secretB32: string, t = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const nextTotpStep = () => new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 500));

describeWithEnv('Stage 21 shared platform integration (all real processes, real RabbitMQ)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  const id = () => crypto.randomUUID();
  const ids = { company: id(), otherCompany: id(), platform: id(), org: id(), owner: id(), member: id(), suspendee: id() };
  const tok = { file: generateServiceToken(), notif: generateServiceToken(), ci: generateServiceToken() };
  const dbs: Record<string, TestDatabase> = {};
  const live: Partial<Record<keyof typeof PORT, LiveService>> = {};
  const envs: Partial<Record<keyof typeof PORT, NodeJS.ProcessEnv>> = {};
  const dirs: Partial<Record<keyof typeof PORT, string>> = {};
  let audit: LiveAudit;
  let broker: BrokerProxy;
  let owner: { token: string; secret: string };
  let member: string;
  const root = mkdtempSync(join(tmpdir(), 's21-file-'));

  const call = async (method: string, target: string, token?: string, body?: unknown, headers: Record<string, string> = {}, raw = false) => {
    const r = await fetch(target, {
      method, body: raw ? new Uint8Array(body as Buffer) : body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(raw || body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const start = async (name: keyof typeof PORT, health = '/health') => {
    live[name] = spawnService(name, dirs[name]!, envs[name]!);
    try {
      await waitForHealth(`${url(name)}${health}`, 30_000);
      // Ready, not just alive: a consumer (Notification) attaches to the broker shortly after its HTTP server is up.
      await waitFor(async () => (await fetch(`${url(name)}/ready`).catch(() => undefined))?.status === 200, 30_000, `${name} /ready`);
    } catch (e) {
      throw new Error(`${String(e)}\n${live[name]!.tail()}`);
    }
  };
  const ready = async (name: keyof typeof PORT | 'audit') => (await fetch(`${name === 'audit' ? audit.url : url(name)}/ready`).catch(() => undefined))?.status ?? 0;
  const stepUp = async (purpose: string) => {
    await nextTotpStep(); // a TOTP code is accepted once per step
    const su = await call('POST', `${url('auth')}/auth/admin/step-up`, owner.token, { purpose, method: 'totp', code: totp(owner.secret) });
    expect(su.status, JSON.stringify(su.body)).toBe(200);
    return su.body.stepUpToken as string;
  };

  // ── representative operations of each capability (used by every failure-isolation probe) ──
  let n = 0;
  const releaseRegister = (headers: Record<string, string> = {}) => call('POST', `${url('release')}/release/products/platform/components/web-app/releases`, tok.ci.token, { kind: 'web', version: `1.${++n}.0` }, headers);
  const releaseRead = () => call('GET', `${url('release')}/release/products/platform/components/web-app/compatibility?version=1.1.0`);
  const fileUpload = async () => call('POST', `${url('file')}/file/files`, tok.file.token, PDF, { 'idempotency-key': id(), 'x-attach': 'true', 'content-type': 'application/pdf', 'x-organization-id': ids.org }, true);
  const fileDelete = (fid: string) => call('DELETE', `${url('file')}/file/files/${fid}`, tok.file.token, undefined, { 'x-organization-id': ids.org });
  const notify = () => call('POST', `${url('notification')}/notification/notifications`, tok.notif.token, { template: 'membership.approved', channels: [{ channel: 'EMAIL', destination: 'someone@e2e.test' }] }, { 'idempotency-key': id() });
  const platformRead = () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    return audit.get(`/audit/platform/records?from=${from}&to=${to}`, audit.platformReader.token);
  };

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    const target = new URL(env.TEST_RABBITMQ_URL);
    broker = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await broker.start();
    const brokerUrl = `amqp://guest:guest@127.0.0.1:${broker.port}`;
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, brokerUrl, PORT.audit, { AUTH_SERVICE_URL: url('auth') });

    // Auth: one Company with a platform and an organization, its owner and one member; another Company (for wrong-Company checks).
    dbs.auth = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2es21auth');
    await runMigrations(dbs.auth.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
    const hash = await bcrypt.hash('member password 1', 4);
    await sql(dbs.auth.url, `INSERT INTO company(id,name) VALUES ($1,'C'),($2,'Other')`, [ids.company, ids.otherCompany]);
    await sql(dbs.auth.url, `INSERT INTO platform(id,"companyId",name) VALUES ($1,$2,'P')`, [ids.platform, ids.company]);
    await sql(dbs.auth.url, `INSERT INTO organization(id,"platformId",name) VALUES ($1,$2,'O')`, [ids.org, ids.platform]);
    const c = new pg.Client({ connectionString: dbs.auth.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'owner','owner-s21@e2e.test',$2,'admin')`, [ids.owner, hash]);
      await c.query(`INSERT INTO owner("userId","companyId") VALUES ($1,$2)`, [ids.owner, ids.company]);
      await c.query(`INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'member','member-s21@e2e.test',$2,'member')`, [ids.member, hash]);
      await c.query(`INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt") VALUES ($1,$2,'active','staff',now())`, [ids.member, ids.org]);
      await c.query(`INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'member','suspendee-s21@e2e.test',$2,'member')`, [ids.suspendee, hash]);
      await c.query(`INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt") VALUES ($1,$2,'active','staff',now())`, [ids.suspendee, ids.org]);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    dirs.auth = AUTH_DIR;
    envs.auth = {
      NODE_ENV: 'test', PORT: String(PORT.auth), DATABASE_URL: dbs.auth.url, AUTH_EVENTS: 'off', RABBITMQ_URL: brokerUrl,
      JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
      TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.e2e.test', WEBAUTHN_ORIGINS: 'https://auth.e2e.test',
      BCRYPT_COST: '4', REQUIRE_CONTACT_VERIFICATION: 'false',
    };

    dbs.file = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2es21file');
    await runMigrations(dbs.file.url, [kitMigrationsDir, `${APPS}file-service/db/migrations/`]);
    dirs.file = `${APPS}file-service`;
    envs.file = {
      NODE_ENV: 'test', PORT: String(PORT.file), DATABASE_URL: dbs.file.url, RABBITMQ_URL: brokerUrl, SERVICE_TOKENS: `product-api:${tok.file.digest}`,
      FILE_SERVICE_POLICY: JSON.stringify({ callers: { 'product-api': { operations: ['upload', 'read', 'delete'], organizations: 'request', mediaTypes: ['application/pdf'], maxBytes: 1_048_576 } } }),
      FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: root, FILE_PUBLIC_BASE_URL: 'http://files.e2e.invalid', FILE_REQUEST_HASH_KEY: b64(), FILE_RATE_LIMIT_KEY: b64(),
    };

    dbs.notification = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2es21notif');
    await runMigrations(dbs.notification.url, [kitMigrationsDir, `${APPS}notification-service/db/migrations/`]);
    dirs.notification = `${APPS}notification-service`;
    envs.notification = {
      NODE_ENV: 'test', PORT: String(PORT.notification), DATABASE_URL: dbs.notification.url, RABBITMQ_URL: brokerUrl, SERVICE_TOKENS: `product-api:${tok.notif.digest}`,
      NOTIFICATION_SERVICE_POLICY: JSON.stringify({ callers: { 'product-api': { templates: ['membership.approved'], channels: ['EMAIL'], organizations: 'none' } } }),
      NOTIFICATION_SECRET_KEYS: `k1:${b64()}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1', NOTIFICATION_DEFAULT_LOCALE: 'en', NOTIFICATION_REQUEST_HASH_KEY: b64(),
    };

    dbs.release = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2es21release');
    await runMigrations(dbs.release.url, [kitMigrationsDir, `${APPS}release-service/db/migrations/`]);
    dirs.release = `${APPS}release-service`;
    envs.release = {
      NODE_ENV: 'test', PORT: String(PORT.release), DATABASE_URL: dbs.release.url, RABBITMQ_URL: brokerUrl, SERVICE_TOKENS: `platform-ci:${tok.ci.digest}`,
      RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { 'platform-ci': { products: { platform: ['release.register', 'release.publish'] } } } }),
      AUTH_SERVICE_URL: url('auth'), RELEASE_OPERATING_COMPANY_ID: ids.company,
    };

    await Promise.all([start('auth'), start('file'), start('notification'), start('release')]);

    // A real owner session (TOTP enrollment) and a member session.
    const s = await call('POST', `${url('auth')}/auth/login`, undefined, { email: 'owner-s21@e2e.test', password: 'member password 1' });
    const begin = await call('POST', `${url('auth')}/auth/admin/enroll/totp`, undefined, { enrollmentToken: s.body.enrollmentToken });
    const confirm = await call('POST', `${url('auth')}/auth/admin/enroll/totp/confirm`, undefined, { enrollmentToken: s.body.enrollmentToken, factorId: begin.body.factorId, code: totp(begin.body.secret) });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    owner = { token: confirm.body.accessToken as string, secret: begin.body.secret as string };
    member = (await call('POST', `${url('auth')}/auth/login`, undefined, { email: 'member-s21@e2e.test', password: 'member password 1' })).body.accessToken as string;
    expect(member).toBeTruthy();
  }, 180_000);

  afterAll(async () => {
    for (const s of Object.values(live)) await s?.stop();
    await audit?.stop();
    await broker?.sever();
    for (const d of Object.values(dbs)) await d?.drop();
    await audit?.db.drop();
    rmSync(root, { recursive: true, force: true });
  });

  describe('the three integration shapes, one evidence stream', () => {
    it('human (Auth step-up → Auth mutation; Auth → Release step-up → Release mutation), service automation (Release, File), public read; evidence lands once, with the right actors and correlation', async () => {
      // Service automation: CI registers and publishes; the product API stores and deletes a document; it asks for a notification.
      const r1 = await releaseRegister();
      expect(r1.status).toBe(201);
      expect((await call('POST', `${url('release')}/release/products/platform/components/web-app/releases/${r1.body.version}/publish`, tok.ci.token)).status).toBe(200);
      const r2 = await releaseRegister();
      expect((await call('POST', `${url('release')}/release/products/platform/components/web-app/releases/${r2.body.version}/publish`, tok.ci.token)).status).toBe(200);
      const up = await fileUpload();
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      expect((await fileDelete(up.body.id)).status).toBe(202);
      expect((await notify()).status).toBe(202);

      // Public read: no identity; answered from Release alone.
      expect((await releaseRead()).body).toMatchObject({ update: 'available' });

      // Human, Auth itself: the owner suspends a member of the Company (factor step-up, Stage 19.2), then restores them.
      const suspend = await call('POST', `${url('auth')}/auth/admin/members/${ids.suspendee}/suspend`, owner.token, { reason: 'security_incident' }, { 'x-step-up-token': await stepUp('account.suspend'), 'x-correlation-id': 'platform-corr-suspend' });
      expect(suspend.status, JSON.stringify(suspend.body)).toBe(200);

      // Human, across services: the owner withdraws a release in Release; Release verifies the owner and consumes the proof THROUGH Auth.
      const withdraw = await call('POST', `${url('release')}/release/admin/products/platform/components/web-app/releases/${r2.body.version}/withdraw`, owner.token, undefined,
        { 'x-step-up-token': await stepUp('release.withdraw'), 'x-correlation-id': 'platform-corr-withdraw' });
      expect(withdraw.status, JSON.stringify(withdraw.body)).toBe(200);

      // One evidence stream: every producer → its outbox → its relay → the one broker → audit-service.
      await waitFor(async () => (await audit.records(`action IN ('release.registered','release.published','release.withdrawn','file.deleted','account.disabled')`)).length === 7, 45_000, 'all evidence');
      await new Promise((r) => setTimeout(r, 1000));
      const rows = await audit.records(`action IN ('release.registered','release.published','release.withdrawn','file.deleted','account.disabled')`);
      const by = (a: string) => rows.filter((r) => r.action === a);
      expect(by('release.registered')).toHaveLength(2);
      expect(by('release.published')).toHaveLength(2);
      expect(by('release.registered')[0]).toMatchObject({ sourceService: 'release-service', actorType: 'service', actorId: 'platform-ci', organizationId: null });
      expect(by('file.deleted')[0]).toMatchObject({ sourceService: 'file-service', actorType: 'service', actorId: 'product-api', organizationId: ids.org });
      expect(by('account.disabled')[0]).toMatchObject({ sourceService: 'auth-service', actorType: 'user', actorId: ids.owner, userKind: 'owner', correlationId: 'platform-corr-suspend' });
      expect(by('release.withdrawn')[0]).toMatchObject({ sourceService: 'release-service', actorType: 'user', actorId: ids.owner, userKind: 'owner', correlationId: 'platform-corr-withdraw' });
      for (const r of rows) {
        const text = JSON.stringify(r);
        for (const re of PROHIBITED) expect(JSON.stringify(r.changes ?? {}), `${r.action}`).not.toMatch(re);
        for (const secret of [owner.token, member, tok.ci.token, tok.file.token, 'member-s21@e2e.test', 'someone@e2e.test']) expect(text).not.toContain(secret);
      }
      // Notification writes no audit (it owns no action) and no public read is audited.
      expect(await audit.records(`"sourceService" = 'notification-service'`)).toEqual([]);
      expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
    }, 240_000);
  });

  describe('credential confusion across services (every credential only where it belongs)', () => {
    it('service tokens, human bearers and forged headers are refused on every surface they do not own', async () => {
      const release = url('release');
      const cases: Array<[string, Promise<{ status: number }>, number]> = [
        ['File token on Release CI', call('POST', `${release}/release/products/platform/components/web-app/releases`, tok.file.token, { kind: 'web', version: '9.0.0' }), 401],
        ['Release CI token on File', call('POST', `${url('file')}/file/files`, tok.ci.token, PDF, { 'idempotency-key': id(), 'content-type': 'application/pdf' }, true), 401],
        ['Release CI token on Notification', call('POST', `${url('notification')}/notification/notifications`, tok.ci.token, { template: 'membership.approved', channels: [] }, { 'idempotency-key': id() }), 401],
        ['Notification token on Release owner admin', call('POST', `${release}/release/admin/products/platform/components/web-app/releases/1.1.0/withdraw`, tok.notif.token, undefined, { 'x-step-up-token': id() }), 401],
        ['File token on Auth owner admin', call('POST', `${url('auth')}/auth/admin/members/${ids.suspendee}/restore`, tok.file.token, {}, { 'x-step-up-token': id() }), 401],
        ['owner bearer on File', call('DELETE', `${url('file')}/file/files/${id()}`, owner.token), 401],
        ['owner bearer on Notification', call('POST', `${url('notification')}/notification/notifications`, owner.token, { template: 'membership.approved', channels: [] }, { 'idempotency-key': id() }), 401],
        ['owner bearer on Release CI', call('POST', `${release}/release/products/platform/components/web-app/releases`, owner.token, { kind: 'web', version: '9.0.1' }), 401],
        ['owner bearer on audit service read', call('GET', `${audit.url}/audit/platform/records?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`, owner.token), 401],
        ['member bearer on Release owner admin', call('POST', `${release}/release/admin/products/platform/components/web-app/releases/1.1.0/withdraw`, member, undefined, { 'x-step-up-token': id() }), 403],
        ['forged identity headers, no credential, on Release owner admin', call('POST', `${release}/release/admin/products/platform/components/web-app/releases/1.1.0/withdraw`, undefined, undefined, { 'x-user-id': ids.owner, 'x-owner': 'true', 'x-company': ids.company, 'x-step-up-token': id() }), 401],
        ['correlation id = the owner id, no credential, on Auth owner admin', call('POST', `${url('auth')}/auth/admin/members/${ids.suspendee}/restore`, undefined, {}, { 'x-correlation-id': ids.owner, 'x-request-id': ids.owner }), 401],
        ['forged service header on File', call('DELETE', `${url('file')}/file/files/${id()}`, undefined, undefined, { 'x-service': 'product-api', 'x-caller': 'product-api' }), 401],
      ];
      for (const [name, p, status] of cases) expect((await p).status, name).toBe(status);
    });

    it('a step-up proof is bound to its purpose ACROSS services: a Release withdrawal proof cannot restore an Auth account (and is not spent by trying)', async () => {
      const proof = await (async () => {
        await nextTotpStep();
        const su = await call('POST', `${url('auth')}/auth/admin/step-up`, owner.token, { purpose: 'release.withdraw', method: 'totp', code: totp(owner.secret) });
        return su.body.stepUpToken as string;
      })();
      const restore = await call('POST', `${url('auth')}/auth/admin/members/${ids.suspendee}/restore`, owner.token, {}, { 'x-step-up-token': proof });
      expect(restore.status).toBe(403);
      // Still valid for its own purpose, in its own service.
      const r = await releaseRegister();
      await call('POST', `${url('release')}/release/products/platform/components/web-app/releases/${r.body.version}/publish`, tok.ci.token);
      const w = await call('POST', `${url('release')}/release/admin/products/platform/components/web-app/releases/${r.body.version}/withdraw`, owner.token, undefined, { 'x-step-up-token': proof });
      expect(w.status, JSON.stringify(w.body)).toBe(200);
    }, 120_000);
  });

  describe('failure isolation (each dependency down in turn; everything else ready and working)', () => {
    const others = async (except: Array<keyof typeof PORT | 'audit'>) => {
      for (const s of (['auth', 'file', 'notification', 'release', 'audit'] as const).filter((x) => !except.includes(x))) expect(await ready(s), `${s} /ready`).toBe(200);
    };

    it('Auth down: CI automation, the public read, File, Notification and the audit service read keep working; owner administration fails closed (Release, Audit-X)', async () => {
      await live.auth!.stop();
      try {
        expect((await releaseRegister()).status).toBe(201);
        expect((await releaseRead()).status).toBe(200);
        const up = await fileUpload();
        expect(up.status).toBe(201);
        expect((await notify()).status).toBe(202);
        expect((await platformRead()).status).toBe(200);
        const admin = await call('POST', `${url('release')}/release/admin/products/platform/components/web-app/releases/1.1.0/withdraw`, owner.token, undefined, { 'x-step-up-token': id() });
        expect([admin.status, admin.body.code]).toEqual([503, 'auth_unavailable']);
        const ownerRead = await audit.get(`/audit/owner/organizations/${ids.org}/records?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`, owner.token);
        expect(ownerRead.status).toBe(503);
        await others(['auth']); // Auth is not a readiness dependency of any shared service
      } finally {
        await start('auth');
      }
    });

    it('broker down: every mutation still commits (Auth, File, Release); only the consumers (audit-service, Notification intake) report unready; evidence arrives once when it returns', async () => {
      await broker.sever();
      let released = '';
      let deleted = '';
      try {
        const r = await releaseRegister();
        expect(r.status).toBe(201);
        released = r.body.id;
        const up = await fileUpload();
        expect(up.status).toBe(201);
        expect((await fileDelete(up.body.id)).status).toBe(202);
        deleted = up.body.id;
        expect((await notify()).status).toBe(202); // the notification API does not depend on the broker (its intake does)
        await waitFor(async () => (await ready('audit')) === 503 && (await ready('notification')) === 503, 30_000, 'the consumers report the broker');
        for (const s of ['auth', 'file', 'release'] as const) expect(await ready(s), `${s} /ready`).toBe(200); // producers: the outbox absorbs it
      } finally {
        await broker.start();
      }
      await waitFor(async () => (await audit.records(`"resourceId" IN ($1, $2)`, [released, deleted])).length === 2, 60_000, 'backlog delivered after the broker returned');
      await new Promise((r) => setTimeout(r, 1500));
      expect(await audit.records(`"resourceId" IN ($1, $2)`, [released, deleted])).toHaveLength(2); // once each
      await waitFor(async () => (await ready('audit')) === 200 && (await ready('notification')) === 200, 30_000, 'consumers recovered');
    }, 180_000);

    it('audit-service down: producers commit and keep their evidence; it arrives, once, when audit-service returns', async () => {
      await audit.stop();
      let released = '';
      try {
        const r = await releaseRegister();
        expect(r.status).toBe(201);
        released = r.body.id;
        await others(['audit']);
      } finally {
        await audit.start();
      }
      await waitFor(async () => (await audit.records(`"resourceId" = $1`, [released])).length === 1, 60_000, 'delivered after audit-service returned');
    }, 120_000);

    it.each(['notification', 'file', 'release'] as const)('%s down: every other shared capability stays ready and working', async (down) => {
      await live[down]!.stop();
      try {
        await others([down]);
        if (down !== 'release') expect((await releaseRegister()).status).toBe(201);
        if (down !== 'file') expect((await fileUpload()).status).toBe(201);
        if (down !== 'notification') expect((await notify()).status).toBe(202);
        expect((await platformRead()).status).toBe(200);
        expect((await call('GET', `${url('auth')}/auth/me`, member)).status).toBeLessThan(500);
      } finally {
        await start(down);
      }
    }, 120_000);
  });
});

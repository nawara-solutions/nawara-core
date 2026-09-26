import { createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, PROHIBITED, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 20.4, ALL REAL: the owner of the operating Company, in a live Auth (its dist build), withdraws a release and changes a minimum
 * version through a live release-service, with REAL factor step-ups (TOTP) that release-service verifies and consumes through Auth. The
 * evidence travels outbox → relay → RabbitMQ → a live audit-service, with the owner as actor. A member, another Company's owner and a CI
 * service token are refused; a proof is single-use and purpose-bound in the real Auth.
 */
const AUTH_DIR = `${APPS}auth-service`;
const RELEASE_DIR = `${APPS}release-service`;
const AUTH_PORT = 3893;
const RELEASE_PORT = 3894;
const AUDIT_PORT = 3895;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const RELEASE_URL = `http://127.0.0.1:${RELEASE_PORT}`;
const b64 = () => randomBytes(32).toString('base64');

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as Auth verifies it; the secret is base32. */
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

describeWithEnv('Release owner administration: real Auth owner + real step-up → release-service → audit-service (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let authDb: TestDatabase;
  let releaseDb: TestDatabase;
  let auth: LiveService;
  let release: LiveService;
  let audit: LiveAudit;
  const ci = generateServiceToken();
  const id = () => crypto.randomUUID();
  const ids = { operating: id(), other: id(), platform: id(), org: id(), owner: id(), otherOwner: id(), member: id() };

  const call = async (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(url, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const enroll = async (email: string) => {
    const start = await call('POST', `${AUTH_URL}/auth/login`, undefined, { email, password: 'member password 1' });
    const begin = await call('POST', `${AUTH_URL}/auth/admin/enroll/totp`, undefined, { enrollmentToken: start.body.enrollmentToken });
    const confirm = await call('POST', `${AUTH_URL}/auth/admin/enroll/totp/confirm`, undefined, { enrollmentToken: start.body.enrollmentToken, factorId: begin.body.factorId, code: totp(begin.body.secret) });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    return { token: confirm.body.accessToken as string, secret: begin.body.secret as string };
  };
  const stepUp = async (o: { token: string; secret: string }, purpose: string) => {
    await nextTotpStep(); // a TOTP code is accepted once: every proof needs a fresh step
    const su = await call('POST', `${AUTH_URL}/auth/admin/step-up`, o.token, { purpose, method: 'totp', code: totp(o.secret) });
    expect(su.status, JSON.stringify(su.body)).toBe(200);
    return su.body.stepUpToken as string;
  };
  const ciCall = (path: string, body?: unknown) => call('POST', `${RELEASE_URL}/release/products/drive/components/web-app${path}`, ci.token, body);
  const admin = (path: string, token: string, proof?: string, body?: unknown) =>
    call('POST', `${RELEASE_URL}/release/admin/products/drive/components/web-app${path}`, token, body, { ...(proof ? { 'x-step-up-token': proof } : {}), 'x-correlation-id': 'release-owner-e2e-01' });

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, AUDIT_PORT);
    authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthrel');
    await runMigrations(authDb.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
    const hash = await bcrypt.hash('member password 1', 4);
    await sql(authDb.url, `INSERT INTO company(id,name) VALUES ($1,'Operating'),($2,'Other')`, [ids.operating, ids.other]);
    await sql(authDb.url, `INSERT INTO platform(id,"companyId",name) VALUES ($1,$2,'P')`, [ids.platform, ids.operating]);
    await sql(authDb.url, `INSERT INTO organization(id,"platformId",name) VALUES ($1,$2,'O')`, [ids.org, ids.platform]);
    const c = new pg.Client({ connectionString: authDb.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      for (const [uid, email, company] of [[ids.owner, 'owner-rel@e2e.test', ids.operating], [ids.otherOwner, 'other-rel@e2e.test', ids.other]] as const) {
        await c.query(`INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'owner',$2,$3,'admin')`, [uid, email, hash]);
        await c.query(`INSERT INTO owner("userId","companyId") VALUES ($1,$2)`, [uid, company]);
      }
      await c.query(`INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'member','member-rel@e2e.test',$2,'member')`, [ids.member, hash]);
      await c.query(`INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt") VALUES ($1,$2,'active','staff',now())`, [ids.member, ids.org]);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    auth = spawnService('auth', AUTH_DIR, {
      NODE_ENV: 'test', PORT: String(AUTH_PORT), DATABASE_URL: authDb.url, AUTH_EVENTS: 'off', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
      TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.e2e.test', WEBAUTHN_ORIGINS: 'https://auth.e2e.test',
      BCRYPT_COST: '4', REQUIRE_CONTACT_VERIFICATION: 'false',
    });
    releaseDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ereleaseowner');
    await runMigrations(releaseDb.url, [kitMigrationsDir, `${RELEASE_DIR}/db/migrations/`]);
    release = spawnService('release', RELEASE_DIR, {
      NODE_ENV: 'test', PORT: String(RELEASE_PORT), DATABASE_URL: releaseDb.url, RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      SERVICE_TOKENS: `drive-ci:${ci.digest}`,
      RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { 'drive-ci': { products: { drive: ['release.register', 'release.publish'] } } } }),
      AUTH_SERVICE_URL: AUTH_URL, RELEASE_OPERATING_COMPANY_ID: ids.operating,
    });
    for (const [s, u] of [[auth, AUTH_URL], [release, RELEASE_URL]] as const) {
      try {
        await waitForHealth(`${u}/health`, 30_000);
      } catch (e) {
        throw new Error(`${String(e)}\n${s.tail()}`);
      }
    }
  });
  afterAll(async () => {
    await release?.stop();
    await auth?.stop();
    await audit?.stop();
    await releaseDb?.drop();
    await authDb?.drop();
    await audit?.db.drop();
  });

  it('the operating owner withdraws and changes the minimum with real step-ups; evidence names the owner; others are refused', async () => {
    for (const v of ['1.0.0', '2.0.0', '3.0.0']) {
      expect((await ciCall('/releases', { kind: 'web', version: v })).status).toBe(201);
      expect((await ciCall(`/releases/${v}/publish`)).status).toBe(200);
    }
    const owner = await enroll('owner-rel@e2e.test');
    const other = await enroll('other-rel@e2e.test');
    const member = (await call('POST', `${AUTH_URL}/auth/login`, undefined, { email: 'member-rel@e2e.test', password: 'member password 1' })).body.accessToken as string;

    // Refused: another Company's owner (even with its own valid proof), a member, the CI token; nothing changes.
    const otherProof = await stepUp(other, 'release.withdraw');
    expect((await admin('/releases/3.0.0/withdraw', other.token, otherProof)).body.code).toBe('operation_not_allowed');
    expect((await admin('/releases/3.0.0/withdraw', member, otherProof)).body.code).toBe('operation_not_allowed');
    expect((await admin('/releases/3.0.0/withdraw', ci.token, otherProof)).status).toBe(401);

    // The minimum: a real "compatibility_policy.change" proof; a withdrawal proof is refused for it (purpose-bound in the real Auth).
    const withdrawProof = await stepUp(owner, 'release.withdraw');
    expect((await admin('/compatibility-policy', owner.token, withdrawProof, { minimumVersion: '2.0.0', expectedPolicyVersion: 0 })).body.code).toBe('step_up_required');
    const policyProof = await stepUp(owner, 'compatibility_policy.change');
    const p = await admin('/compatibility-policy', owner.token, policyProof, { minimumVersion: '2.0.0', expectedPolicyVersion: 0 });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ policyVersion: 1, minimumVersion: '2.0.0', changed: true });
    expect((await admin('/compatibility-policy', owner.token, policyProof, { minimumVersion: '3.0.0', expectedPolicyVersion: 1 })).body.code).toBe('step_up_required'); // single use

    // The withdrawal proof issued earlier was consumed by the refused policy attempt? No: Auth refused it (wrong purpose), so it is still valid.
    const w = await admin('/releases/3.0.0/withdraw', owner.token, withdrawProof);
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body).toMatchObject({ status: 'withdrawn', changed: true });
    const blocked = await admin('/releases/2.0.0/withdraw', owner.token, await stepUp(owner, 'release.withdraw'));
    expect(blocked.body.code).toBe('would_break_minimum'); // minimum 2.0.0 would exceed the new latest 1.0.0

    // Evidence: exactly two owner records in audit_record, the owner as actor, platform-level; no version text or secret.
    await waitFor(async () => (await audit.records(`"sourceService" = 'release-service' AND "actorType" = 'user'`)).length === 2, 30_000, 'two owner records');
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await audit.records(`"sourceService" = 'release-service' AND "actorType" = 'user'`);
    expect(rows.map((r) => r.action).sort()).toEqual(['compatibility_policy.changed', 'release.withdrawn']);
    for (const r of rows) {
      expect(r).toMatchObject({ category: 'security', actorId: ids.owner, userKind: 'owner', organizationId: null, correlationId: 'release-owner-e2e-01' });
      for (const re of PROHIBITED) expect(JSON.stringify(r.changes)).not.toMatch(re);
      expect(JSON.stringify(r)).not.toMatch(/2\.0\.0|3\.0\.0|Bearer/);
    }
    expect(rows.find((r) => r.action === 'compatibility_policy.changed')!.changes).toMatchObject({ policy_version: { from: 0, to: 1 }, kind: 'web' });
    expect(await audit.records(`"sourceService" = 'release-service' AND "actorType" = 'service'`)).toHaveLength(6); // CI: 3 registered + 3 published
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  }, 240_000);
});

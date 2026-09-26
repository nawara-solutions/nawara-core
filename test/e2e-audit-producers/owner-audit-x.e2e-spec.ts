import { createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 19.3 Audit-X, ALL REAL: a Company owner of a live Auth (its dist build) reads, through a live audit-service configured with
 * `AUTH_SERVICE_URL`, the evidence that Auth itself produced (outbox → relay → RabbitMQ → audit_record). Audit verifies the owner and the
 * organization through Auth with the owner's own bearer; the read is recorded with the owner as actor; another Company's organization is a
 * 404; the account-level `account.disabled` of Stage 19.2 (organization none) is never visible to the owner.
 */
const AUTH_DIR = `${APPS}auth-service`;
const AUTH_PORT = 3891;
const AUDIT_PORT = 3892;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
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

describeWithEnv('Audit-X: a real Auth owner reads real evidence through a real audit-service', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let authDb: TestDatabase;
  let auth: LiveService;
  let audit: LiveAudit;
  const id = () => crypto.randomUUID();
  const ids = { companyA: id(), companyB: id(), platformA: id(), platformB: id(), a1: id(), b1: id(), owner: id(), revoked: id(), suspended: id(), member: id() };
  const window = () => ({ from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 19) + 'Z', to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 19) + 'Z' });

  const call = async (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(url, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const ownerRead = (org: string, token: string, headers: Record<string, string> = {}) =>
    call('GET', `${audit.url}/audit/owner/organizations/${org}/records?${new URLSearchParams({ ...window(), limit: '100' })}`, token, undefined, headers);
  const login = async (email: string) => (await call('POST', `${AUTH_URL}/auth/login`, undefined, { email, password: 'member password 1' })).body;

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, AUDIT_PORT, { AUTH_SERVICE_URL: AUTH_URL });
    authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthx');
    await runMigrations(authDb.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
    const hash = await bcrypt.hash('member password 1', 4);
    await sql(authDb.url, `INSERT INTO company(id,name) VALUES ($1,'A'),($2,'B')`, [ids.companyA, ids.companyB]);
    await sql(authDb.url, `INSERT INTO platform(id,"companyId",name) VALUES ($1,$2,'PA'),($3,$4,'PB')`, [ids.platformA, ids.companyA, ids.platformB, ids.companyB]);
    await sql(authDb.url, `INSERT INTO organization(id,"platformId",name) VALUES ($1,$2,'A1'),($3,$4,'B1')`, [ids.a1, ids.platformA, ids.b1, ids.platformB]);
    const c = new pg.Client({ connectionString: authDb.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'owner','owner-x@e2e.test',$2,'admin')`, [ids.owner, hash]);
      await c.query(`INSERT INTO owner("userId","companyId") VALUES ($1,$2)`, [ids.owner, ids.companyA]);
      for (const [uid, email] of [[ids.revoked, 'revoked-x@e2e.test'], [ids.suspended, 'suspended-x@e2e.test'], [ids.member, 'member-x@e2e.test']] as const) {
        await c.query(`INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'member',$2,$3,'member')`, [uid, email, hash]);
        await c.query(`INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt") VALUES ($1,$2,'active','student',now())`, [uid, ids.a1]);
      }
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
    try {
      await waitForHealth(`${AUTH_URL}/health`, 30_000);
    } catch (e) {
      throw new Error(`${String(e)}\n${auth.tail()}`);
    }
  });
  afterAll(async () => {
    await auth?.stop();
    await audit?.stop();
    await authDb?.drop();
    await audit?.db.drop();
  });

  it('the owner reads their organization\'s evidence as themself; another Company\'s organization, account-level evidence and non-owners are refused', async () => {
    // A real owner session (bootstrap enrollment path).
    const start = await call('POST', `${AUTH_URL}/auth/login`, undefined, { email: 'owner-x@e2e.test', password: 'member password 1' });
    expect(start.body.status).toBe('enrollment_required');
    const begin = await call('POST', `${AUTH_URL}/auth/admin/enroll/totp`, undefined, { enrollmentToken: start.body.enrollmentToken });
    const confirm = await call('POST', `${AUTH_URL}/auth/admin/enroll/totp/confirm`, undefined, { enrollmentToken: start.body.enrollmentToken, factorId: begin.body.factorId, code: totp(begin.body.secret) });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    const ownerToken = confirm.body.accessToken as string;

    // Evidence of organization A1 (membership.revoked), and account-level evidence (account.disabled, organization none).
    const suspendedSession = await login('suspended-x@e2e.test');
    const [{ id: membershipId }] = await sql<{ id: string }>(authDb.url, `SELECT id FROM organization_membership WHERE "userId"=$1`, [ids.revoked]);
    expect((await call('POST', `${AUTH_URL}/auth/organizations/${ids.a1}/memberships/${membershipId}/revoke`, ownerToken, {})).status).toBe(200);
    await nextTotpStep();
    const su = await call('POST', `${AUTH_URL}/auth/admin/step-up`, ownerToken, { purpose: 'account.suspend', method: 'totp', code: totp(begin.body.secret) });
    expect(su.status, JSON.stringify(su.body)).toBe(200);
    const suspended = await call('POST', `${AUTH_URL}/auth/admin/members/${ids.suspended}/suspend`, ownerToken, { reason: 'compromised_account' }, { 'x-step-up-token': su.body.stepUpToken });
    expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
    await waitFor(async () => (await audit.records(`action IN ('membership.revoked','account.disabled')`)).length === 2, 30_000, 'both records ingested');
    const [revokedRecord] = await audit.records(`action = 'membership.revoked'`);

    // The owner reads A1: exactly A1's evidence, including the real membership.revoked; never the account-level record.
    const read = await ownerRead(ids.a1, ownerToken, { 'x-owner-id': ids.member, 'x-user-kind': 'operator', 'x-acting-user': ids.member });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.items.map((i: { eventId: string }) => i.eventId)).toContain(revokedRecord.eventId);
    expect(read.body.items.every((i: { organizationId: string }) => i.organizationId === ids.a1)).toBe(true);
    expect(read.body.items.some((i: { action: string }) => i.action === 'account.disabled')).toBe(false);

    // The read is recorded, as the owner, naming the organization; no result content.
    const self = await audit.records(`action = 'platform_query.executed'`);
    expect(self).toHaveLength(1);
    expect(self[0]).toMatchObject({ sourceService: 'audit-service', actorType: 'user', actorId: ids.owner, userKind: 'owner', organizationId: null });
    expect(self[0].changes).toMatchObject({ target: 'organization', organization_id: ids.a1, page: 'first', filtered: false });

    // Another Company's organization: the collapsed 404, nothing recorded.
    const cross = await ownerRead(ids.b1, ownerToken);
    expect(cross.status).toBe(404);
    expect(cross.body.items).toBeUndefined();

    // Non-owners and non-human credentials.
    const member = await login('member-x@e2e.test');
    expect((await ownerRead(ids.a1, member.accessToken)).status).toBe(403);
    expect((await ownerRead(ids.a1, suspendedSession.accessToken)).status).toBe(401); // suspended in 19.2: Auth refuses the old token live
    expect((await ownerRead(ids.a1, audit.orgReader.token)).status).toBe(401); // a service token is not a human
    expect((await audit.records(`action = 'platform_query.executed'`)).length).toBe(1);
  });
});

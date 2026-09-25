import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, PROHIBITED, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 18.7.5 + 18.7.6: REAL Auth (its dist build, AUTH_EVENTS=off as in the production deploy) → its outbox (migration 0010, the same
 * transaction as the Auth change and its local auth_audit_event row) → the kit relay → a REAL RabbitMQ → a live audit-service →
 * audit_record. Two actions of different shapes: an organization admin (a MEMBER) approving a membership, and the system's refresh-token
 * reuse detection. The local record keeps the IP; the central record never carries it.
 */
const AUTH_DIR = `${APPS}auth-service`;
const AUTH_PORT = 3879;
const AUDIT_PORT = 3880;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const IP = '203.0.113.88';
const b64 = () => randomBytes(32).toString('base64');

describeWithEnv('Auth → outbox → RabbitMQ → audit-service (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let authDb: TestDatabase;
  let auth: LiveService;
  let audit: LiveAudit;
  const ids = { company: crypto.randomUUID(), platform: crypto.randomUUID(), org: crypto.randomUUID(), admin: crypto.randomUUID(), applicant: crypto.randomUUID() };

  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(`${AUTH_URL}${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, 'x-correlation-id': 'auth-e2e-corr-01', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, AUDIT_PORT);
    authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauthaudit');
    await runMigrations(authDb.url, [`${AUTH_DIR}/db/migrations/`], { fileTransaction: 'strip', strictHistory: true, adoptLegacyChecksums: true });
    const hash = await bcrypt.hash('member password 1', 4);
    await sql(authDb.url, `INSERT INTO company(id,name) VALUES ($1,'C')`, [ids.company]);
    await sql(authDb.url, `INSERT INTO platform(id,"companyId",name) VALUES ($1,$2,'P')`, [ids.platform, ids.company]);
    await sql(authDb.url, `INSERT INTO organization(id,"platformId",name) VALUES ($1,$2,'Org Name Not In Audit')`, [ids.org, ids.platform]);
    for (const [id, email] of [[ids.admin, 'org-admin@e2e.test'], [ids.applicant, 'applicant@e2e.test']] as const) {
      await sql(authDb.url, `INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'member',$2,$3,'member')`, [id, email, hash]);
    }
    await sql(authDb.url, `INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt","isOrganizationAdmin") VALUES ($1,$2,'active','staff',now(),true)`, [ids.admin, ids.org]);
    await sql(authDb.url, `INSERT INTO organization_membership("userId","organizationId",status,audience) VALUES ($1,$2,'pending','student')`, [ids.applicant, ids.org]);
    auth = spawnService('auth', AUTH_DIR, {
      NODE_ENV: 'test', PORT: String(AUTH_PORT), DATABASE_URL: authDb.url, AUTH_EVENTS: 'off', RABBITMQ_URL: env.TEST_RABBITMQ_URL, TRUST_PROXY: 'true',
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

  it('membership.approved (an org-admin MEMBER) and session.refresh_reuse_detected (system) reach audit_record; the IP stays local', async () => {
    const admin = await post('/auth/login', { email: 'org-admin@e2e.test', password: 'member password 1' });
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    const [{ id: membershipId }] = await sql<{ id: string }>(authDb.url, `SELECT id FROM organization_membership WHERE "userId"=$1`, [ids.applicant]);
    const approved = await post(`/auth/organizations/${ids.org}/memberships/${membershipId}/approve`, {}, admin.body.accessToken);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const applicant = await post('/auth/login', { email: 'applicant@e2e.test', password: 'member password 1' });
    expect(applicant.status).toBe(200);
    expect((await post('/auth/refresh', { refreshToken: applicant.body.refreshToken })).status).toBe(200);
    expect((await post('/auth/refresh', { refreshToken: applicant.body.refreshToken })).status).toBe(401); // reuse of a rotated-out token

    await waitFor(async () => (await audit.records(`"sourceService" = 'auth-service'`)).length === 2, 30_000, 'two auth records');
    const rows = await audit.records(`"sourceService" = 'auth-service'`);
    const by = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(by['membership.approved']).toMatchObject({
      category: 'business', actorType: 'user', actorId: ids.admin, userKind: 'member', organizationId: ids.org, resourceType: 'membership', resourceId: membershipId,
      subjectType: 'user', subjectId: ids.applicant, changes: { authority: 'org_admin' }, correlationId: 'auth-e2e-corr-01',
    });
    expect(by['session.refresh_reuse_detected']).toMatchObject({
      category: 'security', actorType: 'system', actorId: 'refresh_reuse_detection', organizationId: null, resourceId: ids.applicant, outcome: 'denied',
    });
    // The local security trail keeps its own purpose (the IP), the central copy never has it.
    const local = await sql(authDb.url, `SELECT ip FROM auth_audit_event WHERE type = 'membership.approved'`);
    expect(local).toEqual([{ ip: IP }]);
    for (const r of rows) expect(JSON.stringify(r)).not.toContain(IP);
    const payloads = await sql(authDb.url, `SELECT payload FROM outbox`);
    expect(payloads).toHaveLength(2);
    for (const p of payloads) {
      for (const re of PROHIBITED) expect(JSON.stringify(p.payload)).not.toMatch(re);
      expect(JSON.stringify(p.payload)).not.toMatch(/Org Name Not In Audit|@e2e\.test|203\.0\.113/);
    }
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  });
});

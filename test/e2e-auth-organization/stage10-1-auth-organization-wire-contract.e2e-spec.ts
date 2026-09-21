import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { generateSync } from 'otplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 10.1 audit follow-up (MEDIUM finding): proves the REAL HTTP wire contract between
 * organization-service's `HttpAuthGrantsClient` and Auth's real `/auth/grants` and
 * `/auth/step-up/verify` endpoints — two separately spawned, already-built processes talking only
 * over real HTTP, never one service's TypeScript imported into the other's test (mirrors
 * `test/e2e-real-broker`'s established pattern for proving a cross-service transport boundary; see
 * `scripts/lib/checks.mjs`'s cross-service import ban).
 *
 * `apps/organization-service/src/admin/auth-grants-client.spec.ts` already proves the client's own
 * request/response SHAPE handling (including negative/malformed-response cases a live Auth cannot be
 * made to produce on demand) against a stand-in HTTP server. This suite is the complement: the
 * POSITIVE contract, driven by the real Auth process's real authentication, TOTP and step-up logic,
 * so a genuine field rename or behavioral drift in either side would fail here even if both services'
 * own independent test suites still pass.
 *
 * Scope (deliberately narrow, per the Stage 10.1 follow-up spec): one ordinary admin operation
 * (`PATCH /organization/admin/organizations/:id`, member org-admin authority, no step-up) and one
 * sensitive admin operation (`POST /organization/admin/platforms`, owner authority, step-up
 * required), each with one positive and one negative case. This is enough to exercise BOTH
 * `AuthGrantsClient` methods (`grantsFor`, `verifyStepUp`) over the real wire; it does not re-derive
 * the authorization decision matrix itself (already exhaustively covered by
 * `authorization-evaluator.spec.ts` and `admin.e2e-spec.ts`) or Auth's own login/TOTP/step-up logic
 * (already exhaustively covered by auth-service's own e2e suites).
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w auth-service -w organization-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const ORG_DIR = `${ROOT}apps/organization-service`;
const AUTH_PORT = 13201;
const ORG_PORT = 13202;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const ORG_URL = `http://127.0.0.1:${ORG_PORT}`;

const rand = () => randomBytes(32).toString('base64');

/** auth-service applies its own bespoke tracked-SQL migrations (predates @nawara/service-kit, not the kit's
 *  `runMigrations`/`nawara-migrate` — see docker-compose.yml's auth-migrate comment). Copied, not imported,
 *  from apps/auth-service/test/helpers/global-setup.ts's own loop: sequential, sorted, no tracking table
 *  needed for a single-run throwaway database. */
async function applyAuthMigrations(databaseUrl: string): Promise<void> {
  const dir = `${AUTH_DIR}/db/migrations`;
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      await c.query(readFileSync(join(dir, f), 'utf8'));
    }
  } finally {
    await c.end();
  }
}

/** auth-service's full required-env surface (copied, not imported, from apps/auth-service/test/helpers/app.ts — a
 *  service never imports another's source, even its test helpers; see scripts/lib/checks.mjs's checkSource). */
const RATE_BUCKETS = [
  'LOGIN_IP', 'LOGIN_IDENTIFIER', 'REGISTER_IP', 'REFRESH_IP', 'OWNER_VERIFY_OWNER', 'OWNER_VERIFY_IP', 'STEP_UP_OWNER', 'STEP_UP_IP',
  'FACTOR_ENROLL_OWNER', 'RECOVERY_IP', 'RECOVERY_IDENTIFIER', 'OPERATOR_REQUEST_IDENTIFIER', 'OPERATOR_REQUEST_IP', 'OPERATOR_VERIFY_IDENTIFIER',
  'OPERATOR_VERIFY_IP', 'OPERATOR_VERIFY_GLOBAL', 'OPERATOR_CONFIRM_IP',
  'JOIN_CODE_RESOLVE_IP', 'JOIN_CODE_RESOLVE_GLOBAL', 'JOIN_CODE_MANAGE_ACTOR', 'MEMBERSHIP_OP_ACTOR', 'MEMBERSHIP_JOIN_USER', 'CONTACT_REQUEST_USER', 'CONTACT_VERIFY_USER', 'CONTACT_VERIFY_IP',
  'INVITATION_RESOLVE_IP', 'INVITATION_RESOLVE_GLOBAL', 'INVITATION_ACCEPT_IP', 'INVITATION_MANAGE_ACTOR',
];

function authEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: String(AUTH_PORT),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: rand(), OPERATOR_CODE_PEPPER: rand(), SECRET_KEY_PEPPER: rand(), THROTTLE_KEY_PEPPER: rand(), JOIN_CODE_PEPPER: rand(),
    TOTP_ENCRYPTION_KEYS: `k1:${rand()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    WEBAUTHN_RP_ID: 'auth.test', WEBAUTHN_ORIGINS: 'https://auth.test',
    BCRYPT_COST: '4', ACCESS_TOKEN_TTL_SEC: '3600', RECOVERY_COOLDOWN_SEC: '3600', WORK_TIMEZONE: 'UTC',
    ...Object.fromEntries(RATE_BUCKETS.map((b) => [`RATE_${b}_LIMIT`, '100000'])),
  };
}

/** organization-service's ownership state machine gates every write (assertWritable); walks it straight to
 *  ACTIVE the legal way, exactly as apps/organization-service/test/support/app.ts's activateOwnership does
 *  (copied, not imported — same cross-service-import discipline as authEnv above). */
async function activateOwnership(databaseUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query(`UPDATE ownership_state SET environment_class = COALESCE(environment_class, 'fresh')`);
    const phase1 = (await c.query('SELECT phase FROM ownership_state')).rows[0].phase;
    if (phase1 === 'PREPARED') await c.query(`UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = 'test'`);
    const cls = (await c.query('SELECT environment_class FROM ownership_state')).rows[0].environment_class;
    const phase2 = (await c.query('SELECT phase FROM ownership_state')).rows[0].phase;
    if (phase2 === 'VERIFIED' && cls === 'existing') await c.query(`UPDATE ownership_state SET phase = 'FROZEN'`);
    await c.query(`UPDATE ownership_state SET phase = 'ACTIVATABLE', approved_by = 'test', approved_reference = 'test', approved_at = now()`);
    await c.query(`UPDATE ownership_state SET phase = 'ACTIVE', activated_by = 'test', activated_at = now()`);
  } finally {
    await c.end();
  }
}

async function sql<R extends pg.QueryResultRow = any>(url: string, text: string, params: unknown[] = []): Promise<R[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<R>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** Runs several statements in ONE transaction on ONE connection. Required for the owner/operator subtype rows:
 *  `user_require_subtype()` is a DEFERRABLE INITIALLY DEFERRED constraint trigger checked at COMMIT, so the
 *  `user` row and its `owner`/`operator` subtype row must be inserted in the same transaction, exactly as
 *  `UsersService.createOwner`/`createOperator` do it in production (apps/auth-service/src/users/users.service.ts). */
async function sqlTx(url: string, statements: Array<{ text: string; params?: unknown[] }>): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const s of statements) await c.query(s.text, s.params ?? []);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

/** Reads a Response's body as text exactly once and returns both the text (for failure messages) and the
 *  parsed JSON — fetch's body stream can only be consumed once, so callers must never call .json() again. */
async function readJson<T>(res: Response): Promise<{ status: number; text: string; body: T }> {
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as T) : (undefined as T) };
}

/** Waits until the wall clock crosses into the NEXT 30s TOTP step. Auth's replay guard requires each
 *  accepted code's time-step to be strictly newer than the last one accepted for that factor (see
 *  apps/auth-service/src/owner/factor.service.ts) — two codes generated inside the same 30s window
 *  are indistinguishable and the second is rejected as a replay, not a fresh proof. */
async function waitForNextTotpStep(): Promise<void> {
  const intoStep = Date.now() % 30_000;
  await new Promise((resolve) => setTimeout(resolve, 30_000 - intoStep + 500));
}

function totpCodeNow(secret: string): string {
  return generateSync({ secret, strategy: 'totp', epoch: Math.floor(Date.now() / 1000) } as any) as unknown as string;
}

describeWithEnv('Auth <-> Organization Stage 10.1 human-admin wire contract, over real HTTP between two live processes', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let authDb: TestDatabase;
  let orgDb: TestDatabase;
  let auth: LiveService;
  let org: LiveService;

  beforeAll(async () => {
    authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauth');
    orgDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eorg');
    await applyAuthMigrations(authDb.url);
    await runMigrations(orgDb.url, [kitMigrationsDir, `${ORG_DIR}/db/migrations/`]);
    await activateOwnership(orgDb.url);

    auth = spawnService('auth', AUTH_DIR, authEnv(authDb.url));
    org = spawnService('organization', ORG_DIR, {
      NODE_ENV: 'test',
      PORT: String(ORG_PORT),
      DATABASE_URL: orgDb.url,
      SERVICE_TOKENS: '',
      SERVICE_POLICY: '',
      AUTH_SERVICE_URL: AUTH_URL, // the whole point: a REAL HttpAuthGrantsClient pointed at a REAL Auth
    });

    try {
      await Promise.all([waitForHealth(`${AUTH_URL}/auth/health`, 30_000), waitForHealth(`${ORG_URL}/health`, 30_000)]);
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- auth ---\n${auth.tail()}\n--- organization ---\n${org.tail()}`);
    }
  }, 90_000);

  afterAll(async () => {
    await auth?.stop();
    await org?.stop();
    await authDb?.drop();
    await orgDb?.drop();
  }, 45_000);

  // ---------------------------------------------------------------------------------------- fixtures (direct SQL,
  // exactly as organization-service's own test/support/fixtures.ts and admin.e2e-spec.ts seed their own database;
  // never through the other service's TypeScript, only its real schema).

  async function seedMember(opts: { organizationAdmin: boolean }): Promise<{ email: string; password: string; organizationId: string }> {
    const password = `member pass ${randomUUID().slice(0, 8)}`;
    const email = `member-${randomUUID()}@e2e.test`;
    const passwordHash = await bcrypt.hash(password, 4);
    const companyId = randomUUID();
    const platformId = randomUUID();
    const organizationId = randomUUID();
    const userId = randomUUID();
    await sql(authDb.url, `INSERT INTO company(id,name) VALUES ($1,'E2E Co')`, [companyId]);
    await sql(authDb.url, `INSERT INTO platform(id,"companyId",name) VALUES ($1,$2,'E2E Platform')`, [platformId, companyId]);
    await sql(authDb.url, `INSERT INTO organization(id,"platformId",name) VALUES ($1,$2,'E2E Org')`, [organizationId, platformId]);
    await sqlTx(authDb.url, [
      { text: `INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'member',$2,$3,'member')`, params: [userId, email, passwordHash] },
      {
        text: `INSERT INTO organization_membership("userId","organizationId",status,audience,"isOrganizationAdmin","approvedAt") VALUES ($1,$2,'active','member',$3,now())`,
        params: [userId, organizationId, opts.organizationAdmin],
      },
    ]);
    // The matching Company -> Platform -> Organization chain in organization-service's OWN database (same ids by
    // convention — the cross-service correlation this whole authorization model rests on, ADR-0042 decision 6).
    await sql(orgDb.url, `INSERT INTO company(id,name) VALUES ($1,'E2E Co')`, [companyId]);
    await sql(orgDb.url, `INSERT INTO platform(id,"companyId",name) VALUES ($1,$2,'E2E Platform')`, [platformId, companyId]);
    await sql(orgDb.url, `INSERT INTO organization(id,"platformId",name) VALUES ($1,$2,'E2E Org')`, [organizationId, platformId]);
    return { email, password, organizationId };
  }

  async function seedOwner(): Promise<{ email: string; password: string; companyId: string }> {
    const password = `owner pass ${randomUUID().slice(0, 8)}`;
    const email = `owner-${randomUUID()}@e2e.test`;
    const passwordHash = await bcrypt.hash(password, 4);
    const companyId = randomUUID();
    const userId = randomUUID();
    await sql(authDb.url, `INSERT INTO company(id,name) VALUES ($1,'E2E Owner Co')`, [companyId]);
    await sqlTx(authDb.url, [
      { text: `INSERT INTO "user"(id,kind,email,"passwordHash",role) VALUES ($1,'owner',$2,$3,'admin')`, params: [userId, email, passwordHash] },
      { text: `INSERT INTO owner("userId","companyId") VALUES ($1,$2)`, params: [userId, companyId] },
    ]);
    await sql(orgDb.url, `INSERT INTO company(id,name) VALUES ($1,'E2E Owner Co')`, [companyId]);
    return { email, password, companyId };
  }

  // ---------------------------------------------------------------------------------------- real HTTP flows

  async function memberLogin(email: string, password: string): Promise<string> {
    const res = await fetch(`${AUTH_URL}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const { status, text, body } = await readJson<{ accessToken: string }>(res);
    expect(status, text).toBe(200);
    return body.accessToken;
  }

  /** Bootstrap path: password -> enrollment_required -> enroll TOTP -> first session (real HTTP, mirrors
   *  auth-service's own test/helpers/app.ts enrollFirstTotp). Returns a live access token AND the TOTP secret,
   *  already past the enrollment-confirm code's time step. */
  async function ownerEnrollAndLogin(email: string, password: string): Promise<{ accessToken: string; totpSecret: string }> {
    const login = await fetch(`${AUTH_URL}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    expect(login.status, await login.clone().text()).toBe(200);
    const loginBody = (await login.json()) as { status: string; enrollmentToken: string };
    expect(loginBody.status).toBe('enrollment_required');

    const begin = await fetch(`${AUTH_URL}/auth/admin/enroll/totp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enrollmentToken: loginBody.enrollmentToken }) });
    expect(begin.status, await begin.clone().text()).toBe(200);
    const beginBody = (await begin.json()) as { factorId: string; secret: string };

    const confirm = await fetch(`${AUTH_URL}/auth/admin/enroll/totp/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentToken: loginBody.enrollmentToken, factorId: beginBody.factorId, code: totpCodeNow(beginBody.secret) }),
    });
    expect(confirm.status, await confirm.clone().text()).toBe(200);
    const confirmBody = (await confirm.json()) as { accessToken: string };

    await waitForNextTotpStep(); // the enrollment-confirm code already consumed this window's time step
    return { accessToken: confirmBody.accessToken, totpSecret: beginBody.secret };
  }

  async function stepUpToken(accessToken: string, totpSecret: string, purpose: string): Promise<string> {
    const res = await fetch(`${AUTH_URL}/auth/admin/step-up`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose, method: 'totp', code: totpCodeNow(totpSecret) }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { stepUpToken: string };
    return body.stepUpToken;
  }

  // ---------------------------------------------------------------------------------------- the wire-contract proofs

  it('grantsFor: a real member with an active org-admin membership can update that Organization through the real HttpAuthGrantsClient (ordinary op, no step-up)', async () => {
    const m = await seedMember({ organizationAdmin: true });
    const accessToken = await memberLogin(m.email, m.password);

    const res = await fetch(`${ORG_URL}/organization/admin/organizations/${m.organizationId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed via real wire contract' }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('Renamed via real wire contract');
  });

  it('grantsFor: a real member WITHOUT org-admin authority on that Organization is denied (the empty-memberships shape is also a real, correctly-parsed response)', async () => {
    const m = await seedMember({ organizationAdmin: false });
    const accessToken = await memberLogin(m.email, m.password);

    const res = await fetch(`${ORG_URL}/organization/admin/organizations/${m.organizationId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Should never apply' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('admin_forbidden');
  });

  it('verifyStepUp: a real owner with a real, freshly-verified TOTP step-up can create a Platform through the real HttpAuthGrantsClient (sensitive op)', async () => {
    const o = await seedOwner();
    const { accessToken, totpSecret } = await ownerEnrollAndLogin(o.email, o.password);
    const token = await stepUpToken(accessToken, totpSecret, 'platform.create');

    const res = await fetch(`${ORG_URL}/organization/admin/platforms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'idempotency-key': `k-${randomUUID()}`, 'x-step-up-token': token },
      body: JSON.stringify({ companyId: o.companyId, name: 'Real Wire Contract Platform' }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { companyId: string };
    expect(body.companyId).toBe(o.companyId);
  }, 60_000);

  it('verifyStepUp: a garbage step-up token is a real 403 from Auth, correctly interpreted by the real client as denied (not thrown, not silently accepted)', async () => {
    const o = await seedOwner();
    const { accessToken } = await ownerEnrollAndLogin(o.email, o.password);

    const res = await fetch(`${ORG_URL}/organization/admin/platforms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'idempotency-key': `k-${randomUUID()}`, 'x-step-up-token': 'not-a-real-step-up-token-at-all' },
      body: JSON.stringify({ companyId: o.companyId, name: 'Should never be created' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('step_up_required');
  }, 60_000);
});

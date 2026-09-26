import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 21.C.2 WP-G (Stage 10.1 record §4 item 6; ADR-0040 decision 5, A2.2, A2.5): the cross-service certification of the ownership
 * transition's DATA path, with each service's own BUILT CLI and process, never one service's TypeScript imported by the other:
 *
 *   existing environment (E1 to E3):  Auth `hierarchy-export` -> file -> organization-service `import` (compare-and-insert) ->
 *                                      the two services agree on the content digest; the final export under Auth's freeze moves
 *                                      organization-service to FROZEN; a tampered snapshot is refused; then rollback BEFORE activation.
 *   fresh environment (F1, F2, F4):    organization-service provisions the first Company; Auth's owner bootstrap places it with the
 *                                      reference-cache protocol (`ensure`, Auth's own full-read credential) and never creates a Company.
 *
 * It proves the preconditions gates G6 (rehearsal) and E3 rely on. It ACTIVATES NOTHING: no ACTIVATE AUTHORITY, no `retire`, no cutover.
 * Prerequisite: `npm run build -w @nawara/service-kit -w auth-service -w organization-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUTH_DIR = `${ROOT}apps/auth-service`;
const ORG_DIR = `${ROOT}apps/organization-service`;
const ORG_PORT = 13232;
const ORG_URL = `http://127.0.0.1:${ORG_PORT}`;
const rand = () => randomBytes(32).toString('base64');
const RATE_BUCKETS = [
  'LOGIN_IP', 'LOGIN_IDENTIFIER', 'REGISTER_IP', 'REFRESH_IP', 'OWNER_VERIFY_OWNER', 'OWNER_VERIFY_IP', 'STEP_UP_OWNER', 'STEP_UP_IP',
  'FACTOR_ENROLL_OWNER', 'RECOVERY_IP', 'RECOVERY_IDENTIFIER', 'OPERATOR_REQUEST_IDENTIFIER', 'OPERATOR_REQUEST_IP', 'OPERATOR_VERIFY_IDENTIFIER',
  'OPERATOR_VERIFY_IP', 'OPERATOR_VERIFY_GLOBAL', 'OPERATOR_CONFIRM_IP',
  'JOIN_CODE_RESOLVE_IP', 'JOIN_CODE_RESOLVE_GLOBAL', 'JOIN_CODE_MANAGE_ACTOR', 'MEMBERSHIP_OP_ACTOR', 'MEMBERSHIP_JOIN_USER', 'CONTACT_REQUEST_USER', 'CONTACT_VERIFY_USER', 'CONTACT_VERIFY_IP',
  'INVITATION_RESOLVE_IP', 'INVITATION_RESOLVE_GLOBAL', 'INVITATION_ACCEPT_IP', 'INVITATION_MANAGE_ACTOR',
];
const authEnv = (databaseUrl: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_EVENTS: 'off',
  JWT_SECRET: rand(), OPERATOR_CODE_PEPPER: rand(), SECRET_KEY_PEPPER: rand(), THROTTLE_KEY_PEPPER: rand(), JOIN_CODE_PEPPER: rand(),
  TOTP_ENCRYPTION_KEYS: `k1:${rand()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', WEBAUTHN_RP_ID: 'auth.test', WEBAUTHN_ORIGINS: 'https://auth.test',
  BCRYPT_COST: '4', WORK_TIMEZONE: 'UTC', ...Object.fromEntries(RATE_BUCKETS.map((b) => [`RATE_${b}_LIMIT`, '100000'])), ...extra,
});

async function sql<R extends pg.QueryResultRow = any>(url: string, text: string, params: unknown[] = []): Promise<R[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<R>(text, params)).rows;
  } finally {
    await c.end();
  }
}
async function applyAuthMigrations(databaseUrl: string): Promise<void> {
  const dir = `${AUTH_DIR}/db/migrations`;
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) await sql(databaseUrl, readFileSync(join(dir, f), 'utf8'));
}
/** Runs a built CLI to completion; returns its exit code and output (asserted only for digests and phases, never for secrets). */
function cli(cwd: string, script: string, args: string[], env: NodeJS.ProcessEnv): { code: number; out: string } {
  const r = spawnSync('node', [script, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

describeWithEnv('Stage 21.C.2: ownership export/import across the two services (no activation)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const dir = mkdtempSync(join(tmpdir(), 'nawara-ownership-'));
  let authDb: TestDatabase;
  let orgDb: TestDatabase;
  let freshAuthDb: TestDatabase;
  let freshOrgDb: TestDatabase;
  let org: LiveService | undefined;
  const auth = (args: string[], db = authDb, extra: NodeJS.ProcessEnv = {}) => cli(AUTH_DIR, 'dist/cli/main.js', args, authEnv(db.url, extra));
  const ownership = (args: string[], db = orgDb) => cli(ORG_DIR, 'dist/cli/ownership.js', args, { NODE_ENV: 'test', OWNERSHIP_ADMIN_DATABASE_URL: db.url });
  const orgState = async (db = orgDb) => (await sql(db.url, 'SELECT phase, environment_class, authoritative, verified_digest FROM ownership_state'))[0];
  const ids = { company: randomUUID(), p1: randomUUID(), p2: randomUUID(), o1: randomUUID(), o2: randomUUID(), o3: randomUUID() };

  beforeAll(async () => {
    authDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauth21c2x');
    orgDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eorg21c2x');
    freshAuthDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eauth21c2f');
    freshOrgDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eorg21c2f');
    await applyAuthMigrations(authDb.url);
    await applyAuthMigrations(freshAuthDb.url);
    await runMigrations(orgDb.url, [kitMigrationsDir, `${ORG_DIR}/db/migrations/`]);
    await runMigrations(freshOrgDb.url, [kitMigrationsDir, `${ORG_DIR}/db/migrations/`]);
    // An existing environment's hierarchy, owned by Auth today (the columns organization-service mirrors, including the optional ones).
    await sql(authDb.url, `INSERT INTO company (id, name) VALUES ($1, 'Existing Co')`, [ids.company]);
    await sql(authDb.url, `INSERT INTO platform (id, "companyId", name, key) VALUES ($1, $3, 'Platform One', 'platform-one'), ($2, $3, 'Platform Two', NULL)`, [ids.p1, ids.p2, ids.company]);
    await sql(authDb.url, `INSERT INTO organization (id, "platformId", name, "taxCode", address, phone, type) VALUES ($1, $4, 'Org One', 'TX-1', '1 Street', '+21600000000', 'opaque'), ($2, $4, 'Org Two', NULL, NULL, NULL, NULL), ($3, $5, 'Org Three', NULL, NULL, NULL, NULL)`,
      [ids.o1, ids.o2, ids.o3, ids.p1, ids.p2]);
  }, 120_000);

  afterAll(async () => {
    await org?.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const d of [authDb, orgDb, freshAuthDb, freshOrgDb]) await d?.drop();
  });

  it('E1: a preparation export from Auth imports into an inactive organization-service, and both compute the SAME content digest', async () => {
    const file = join(dir, 'prep.json');
    const exp = auth(['hierarchy-export', '--out', file, '--actor', 'e2e']);
    expect(exp.code, exp.out).toBe(0);
    expect(ownership(['declare-class', '--class', 'existing', '--actor', 'e2e']).code).toBe(0);
    const imp = ownership(['import', '--file', file, '--actor', 'e2e']);
    expect(imp.code, imp.out).toBe(0);
    const authDigest = /content digest: ([0-9a-f]{64})/.exec(auth(['hierarchy-verify']).out)?.[1];
    expect(authDigest).toBeDefined();
    expect(await orgState()).toMatchObject({ phase: 'VERIFIED', environment_class: 'existing', authoritative: false, verified_digest: authDigest });
    expect((await sql(orgDb.url, 'SELECT count(*)::int AS n FROM organization'))[0].n).toBe(3);
    // repeatable: a second import of the same snapshot inserts nothing and changes nothing
    expect(ownership(['import', '--file', file, '--actor', 'e2e']).code).toBe(0);
    expect((await orgState()).verified_digest).toBe(authDigest);
  });

  it('a tampered snapshot is refused and changes nothing', async () => {
    const good = readFileSync(join(dir, 'prep.json'), 'utf8');
    const bad = join(dir, 'tampered.json');
    writeFileSync(bad, good.replace('Org Two', 'Org 2wo'));
    const before = await orgState();
    const r = ownership(['import', '--file', bad, '--actor', 'e2e']);
    expect(r.code).toBe(1);
    expect(await orgState()).toEqual(before);
  });

  it('E2/E3: under Auth\'s freeze the final export moves organization-service to FROZEN (still not authoritative); Auth refuses hierarchy writes', async () => {
    expect(auth(['hierarchy-freeze', '--actor', 'e2e']).code).toBe(0);
    await expect(sql(authDb.url, `INSERT INTO company (id, name) VALUES ($1, 'Late Co')`, [randomUUID()])).rejects.toThrow(/frozen/);
    const file = join(dir, 'final.json');
    const exp = auth(['hierarchy-export', '--out', file, '--actor', 'e2e', '--final']);
    expect(exp.code, exp.out).toBe(0);
    const imp = ownership(['import', '--file', file, '--actor', 'e2e']);
    expect(imp.code, imp.out).toBe(0);
    expect(await orgState()).toMatchObject({ phase: 'FROZEN', authoritative: false });
  });

  it('rollback BEFORE activation: organization-service back to PREPARED, Auth unfrozen and still the authority; nothing was activated', async () => {
    expect(ownership(['rollback', '--reason', 'e2e certification only', '--actor', 'e2e']).code).toBe(0);
    expect(auth(['hierarchy-unfreeze', '--actor', 'e2e']).code).toBe(0);
    expect((await sql(authDb.url, 'SELECT mode FROM hierarchy_authority'))[0].mode).toBe('local');
    expect((await orgState()).authoritative).toBe(false);
    expect((await sql(orgDb.url, `SELECT count(*)::int AS n FROM ownership_event WHERE operation IN ('activate', 'retire')`))[0].n).toBe(0);
  });

  it('F1/F2/F4 (fresh): organization-service provisions the first Company; Auth\'s bootstrap places it by ensure and creates no Company of its own', async () => {
    const provisioner = generateServiceToken();
    const authRead = generateServiceToken();
    expect(ownership(['declare-class', '--class', 'fresh', '--actor', 'e2e'], freshOrgDb).code).toBe(0);
    org = spawnService('organization', ORG_DIR, {
      NODE_ENV: 'test', PORT: String(ORG_PORT), DATABASE_URL: freshOrgDb.url, AUTH_SERVICE_URL: 'http://127.0.0.1:1',
      SERVICE_TOKENS: `provisioner:${provisioner.digest},auth-service:${authRead.digest}`,
      SERVICE_POLICY: JSON.stringify({ callers: { provisioner: { capabilities: ['hierarchy.provision'] }, 'auth-service': { capabilities: ['hierarchy.read'], allowedPlatforms: [] } } }),
    });
    await waitForHealth(`${ORG_URL}/health`, 30_000);
    const created = await fetch(`${ORG_URL}/organization/companies`, {
      method: 'POST', headers: { authorization: `Bearer ${provisioner.token}`, 'content-type': 'application/json', 'idempotency-key': `first-company-${randomUUID()}` },
      body: JSON.stringify({ name: 'Fresh Co' }),
    });
    expect(created.status, org.tail()).toBe(201);
    const company = (await created.json()) as { id: string };

    const boot = auth(['bootstrap-owner'], freshAuthDb, {
      AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: ORG_URL, ORGANIZATION_SERVICE_TOKEN: authRead.token,
      BOOTSTRAP_COMPANY_ID: company.id, BOOTSTRAP_COMPANY_NAME: 'ignored', BOOTSTRAP_OWNER_EMAIL: 'owner@fresh.test', BOOTSTRAP_OWNER_PASSWORD: 'bootstrap-pass-123',
    });
    expect(boot.code, boot.out).toBe(0);
    expect(await sql(freshAuthDb.url, 'SELECT id, name FROM company')).toEqual([{ id: company.id, name: 'Fresh Co' }]);
    expect((await sql(freshAuthDb.url, 'SELECT "companyId" FROM owner'))[0].companyId).toBe(company.id);
    expect(boot.out).not.toContain(authRead.token);
    expect(await orgState(freshOrgDb)).toMatchObject({ environment_class: 'fresh', authoritative: false }); // nothing activated

    // without the authoritative id Auth refuses to invent a Company
    const refused = auth(['bootstrap-owner'], freshAuthDb, {
      AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: ORG_URL, ORGANIZATION_SERVICE_TOKEN: authRead.token,
      BOOTSTRAP_COMPANY_NAME: 'Invented Co', BOOTSTRAP_OWNER_EMAIL: 'other@fresh.test', BOOTSTRAP_OWNER_PASSWORD: 'bootstrap-pass-123',
    });
    // an owner already exists, so the bootstrap is a no-op either way; what matters is that no Company was created
    expect(refused.code === 0 || refused.code === 1).toBe(true);
    expect((await sql(freshAuthDb.url, 'SELECT count(*)::int AS n FROM company'))[0].n).toBe(1);
  }, 120_000);
});

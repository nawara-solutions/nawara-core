import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { AUTH_MIGRATIONS_DIR } from '../src/db/migrations.js';

/**
 * V2 A4.3 (A4 record §7): Auth's two operator CLIs as processes: the BUILT `dist/cli/migrate.js` and `dist/cli/main.js` (Core CI builds
 * the service before its integration tests), exactly as the deploy script, the restore drill and the runbooks run them. The output is
 * checked never to carry a value (SENTINEL appears in every secret and URL the tests hand the CLIs).
 */
const SENTINEL = 'zq7sentinelvalue';
const DRILL_SUMMARY = /^migrations: ([0-9]+) applied, ([0-9]+) already applied, ([0-9]+) checksum\(s\) recorded$/; // infra/backup/restore-drill.sh
const MIGRATION_FILES = readdirSync(AUTH_MIGRATIONS_DIR).filter((n) => /^\d{4}_.*\.sql$/.test(n)).length;
const cli = (name: string) => fileURLToPath(new URL(`../dist/cli/${name}.js`, import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'auth-cli-'));
const file = (content: string) => {
  const path = join(dir, randomUUID());
  writeFileSync(path, content);
  return path;
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(name: 'migrate' | 'main', args: string[], env: Record<string, string | undefined>) {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const r = spawnSync(process.execPath, [cli(name), ...args], { env: { PATH: process.env.PATH ?? '', ...clean }, encoding: 'utf8', timeout: 60_000 });
  expect(r.stdout + r.stderr, `${name}: no value in the output`).not.toContain(SENTINEL);
  // Node's own runtime warnings (a dependency's experimental Web Crypto use, depending on the Node version) are not the CLI's output.
  const stderr = r.stderr.split('\n').filter((l) => !/^\(node:\d+\) ExperimentalWarning: /.test(l) && !l.startsWith('(Use `node --trace-warnings')).join('\n');
  return { status: r.status, stdout: r.stdout.trim(), stderr: stderr.trim() };
}

const created: string[] = [];
const adminUrl = () => inject('pgAdminUrl');
const urlOf = (db: string) => adminUrl().replace(/\/[^/]*$/, `/${db}`);
async function database(template?: string): Promise<string> {
  const name = `cli_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const a = new pg.Client({ connectionString: adminUrl() });
  await a.connect();
  await a.query(`CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ''}`);
  await a.end();
  created.push(name);
  return urlOf(name);
}
async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}
afterAll(async () => {
  const a = new pg.Client({ connectionString: adminUrl() });
  await a.connect();
  for (const n of created) await a.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  await a.end();
});

const key = () => randomBytes(32).toString('base64');
/** The service configuration the CLI loads (the same loader as the service), against a migrated database. */
const serviceEnv = (databaseUrl: string): Record<string, string> => ({
  NODE_ENV: 'test', DATABASE_URL: databaseUrl, JWT_SECRET: key(), OPERATOR_CODE_PEPPER: key(), SECRET_KEY_PEPPER: key(), THROTTLE_KEY_PEPPER: key(),
  JOIN_CODE_PEPPER: key(), TOTP_ENCRYPTION_KEYS: `k1:${key()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1', BCRYPT_COST: '4', LOG_LEVEL: 'error',
});
const owner = async (url: string) =>
  (await query<{ email: string; passwordHash: string }>(url, `SELECT email, "passwordHash" FROM "user" WHERE kind = 'owner'`))[0];
const company = async (url: string) => (await query<{ name: string }>(url, 'SELECT name FROM company'))[0];
const domainEventRows = async (url: string) =>
  Number((await query<{ n: string }>(url, `SELECT count(*) AS n FROM outbox WHERE name NOT LIKE 'audit.%'`))[0]!.n);

describe('V2 A4.3: characterization of the Auth CLIs (unchanged by the EnvReader conversion)', () => {
  describe('migrate.js', () => {
    it('MIGRATION_DATABASE_URL is mandatory: the exact MigrationError line, exit 1, nothing on stdout', () => {
      const r = run('migrate', [], {});
      expect(r).toEqual({ status: 1, stdout: '', stderr: 'migration failed: MIGRATION_DATABASE_URL is required (the schema owner, not the runtime role)' });
    });

    it('DATABASE_URL (the runtime role) is never a fallback', async () => {
      const url = await database();
      const r = run('migrate', [], { DATABASE_URL: url });
      expect(r).toEqual({ status: 1, stdout: '', stderr: 'migration failed: MIGRATION_DATABASE_URL is required (the schema owner, not the runtime role)' });
      expect(await query(url, `SELECT to_regclass('schema_migrations') AS t`)).toEqual([{ t: null }]); // nothing was migrated
    });

    it('a refused connection is reported by its facts only, never the URL or its credentials', async () => {
      const url = new URL(await database());
      url.username = `${SENTINEL}user`;
      url.password = `${SENTINEL}pass`;
      const r = run('migrate', [], { MIGRATION_DATABASE_URL: url.toString() });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^migration failed: /);
      expect(r.stderr).not.toContain(url.host);
    });

    it('an empty database is migrated; the summary is the restore drill\'s exact contract; a rerun changes nothing', async () => {
      const url = await database();
      const first = run('migrate', [], { MIGRATION_DATABASE_URL: url });
      expect(first.status).toBe(0);
      const summary = first.stdout.split('\n').at(-1)!;
      expect(summary).toMatch(DRILL_SUMMARY);
      expect(summary).toBe(`migrations: ${MIGRATION_FILES} applied, 0 already applied, 0 checksum(s) recorded`);
      const again = run('migrate', [], { MIGRATION_DATABASE_URL: url });
      expect(again.status).toBe(0);
      expect(again.stdout.split('\n').at(-1)).toBe(`migrations: 0 applied, ${MIGRATION_FILES} already applied, 0 checksum(s) recorded`);
    });
  });

  describe('main.js', () => {
    it('an unknown command is refused with the usage line, exit 1', async () => {
      const r = run('main', ['no-such-command'], serviceEnv(await database(inject('pgTemplate'))));
      expect(r.status).toBe(1);
      expect(r.stderr).toBe('usage: main.js bootstrap-owner | reseal-totp-keys | check-totp-keys | hierarchy-status|verify|freeze|unfreeze|export|retire');
    });

    it('bootstrap-owner refuses missing inputs with its fixed line, exit 1, creating nothing', async () => {
      const url = await database(inject('pgTemplate'));
      for (const missing of ['BOOTSTRAP_COMPANY_NAME', 'BOOTSTRAP_OWNER_EMAIL', 'BOOTSTRAP_OWNER_PASSWORD']) {
        const env: Record<string, string | undefined> = {
          ...serviceEnv(url), BOOTSTRAP_COMPANY_NAME: 'Acme', BOOTSTRAP_OWNER_EMAIL: 'owner@acme.test', BOOTSTRAP_OWNER_PASSWORD: `${SENTINEL}-password`, [missing]: undefined,
        };
        const r = run('main', ['bootstrap-owner'], env);
        expect(r, missing).toEqual({ status: 1, stdout: '', stderr: 'BOOTSTRAP_COMPANY_NAME, BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD are required' });
      }
      expect(await owner(url)).toBeUndefined();
    });

    it('bootstrap-owner creates the owner (exit 0, "owner created"); a second run changes nothing and exits 1', async () => {
      const url = await database(inject('pgTemplate'));
      const env = { ...serviceEnv(url), BOOTSTRAP_COMPANY_NAME: 'Acme', BOOTSTRAP_OWNER_EMAIL: 'Owner@Acme.test', BOOTSTRAP_OWNER_PASSWORD: `${SENTINEL}-password` };
      expect(run('main', ['bootstrap-owner'], env)).toEqual({ status: 0, stdout: 'owner created', stderr: '' });
      const o = await owner(url);
      expect(o!.email).toBe('owner@acme.test');
      expect(await bcrypt.compare(`${SENTINEL}-password`, o!.passwordHash)).toBe(true);
      expect(await company(url)).toEqual({ name: 'Acme' });
      expect(run('main', ['bootstrap-owner'], { ...env, BOOTSTRAP_OWNER_PASSWORD: `${SENTINEL}-other-password` }))
        .toEqual({ status: 1, stdout: 'an owner already exists: nothing changed', stderr: '' });
      expect((await owner(url))!.passwordHash).toBe(o!.passwordHash);
    });

    it('the bootstrap password is kept byte for byte, leading and trailing whitespace included', async () => {
      const url = await database(inject('pgTemplate'));
      const password = `  ${SENTINEL} pass \t`;
      const r = run('main', ['bootstrap-owner'], { ...serviceEnv(url), BOOTSTRAP_COMPANY_NAME: 'Acme', BOOTSTRAP_OWNER_EMAIL: 'owner@acme.test', BOOTSTRAP_OWNER_PASSWORD: password });
      expect(r.status).toBe(0);
      const hash = (await owner(url))!.passwordHash;
      expect(await bcrypt.compare(password, hash)).toBe(true);
      expect(await bcrypt.compare(password.trim(), hash)).toBe(false);
    });

    it('the CLI never writes a domain event, even when the environment says AUTH_EVENTS=on', async () => {
      const url = await database(inject('pgTemplate'));
      const before = await domainEventRows(url);
      const r = run('main', ['bootstrap-owner'], {
        ...serviceEnv(url), AUTH_EVENTS: 'on', BOOTSTRAP_COMPANY_NAME: 'Acme', BOOTSTRAP_OWNER_EMAIL: 'owner@acme.test', BOOTSTRAP_OWNER_PASSWORD: `${SENTINEL}-password`,
      });
      expect(r.status).toBe(0);
      expect(await domainEventRows(url)).toBe(before);
    });

    it('a configuration error fails with exit 1 and names the variable, never a value', async () => {
      const env: Record<string, string | undefined> = { ...serviceEnv(await database(inject('pgTemplate'))), JWT_SECRET: undefined, OPERATOR_CODE_PEPPER: `${SENTINEL}` };
      const r = run('main', ['check-totp-keys'], env);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('JWT_SECRET is required');
    });
  });
});

describe('V2 A4.3: the CLIs on the kit EnvReader (intended changes)', () => {
  const REQUIRED = 'migration failed: MIGRATION_DATABASE_URL is required (the schema owner, not the runtime role)';
  const migrated = async (url: string) => (await query(url, `SELECT to_regclass('schema_migrations') AS t`))[0]!.t !== null;
  const bootstrapEnv = async (over: Record<string, string | undefined> = {}) => {
    const url = await database(inject('pgTemplate'));
    return { url, env: { ...serviceEnv(url), BOOTSTRAP_COMPANY_NAME: 'Acme', BOOTSTRAP_OWNER_EMAIL: 'owner@acme.test', BOOTSTRAP_OWNER_PASSWORD: `${SENTINEL}-password`, ...over } };
  };

  describe('migrate.js', () => {
    it('MIGRATION_DATABASE_URL_FILE is read (trailing newline removed) and gives the same summary', async () => {
      const url = await database();
      const r = run('migrate', [], { MIGRATION_DATABASE_URL_FILE: file(`${url}\n`) });
      expect(r.status).toBe(0);
      expect(r.stdout.split('\n').at(-1)).toBe(`migrations: ${MIGRATION_FILES} applied, 0 already applied, 0 checksum(s) recorded`);
    });

    it('MIGRATION_DATABASE_URL and MIGRATION_DATABASE_URL_FILE together are refused before anything is touched', async () => {
      const url = await database();
      const r = run('migrate', [], { MIGRATION_DATABASE_URL: url, MIGRATION_DATABASE_URL_FILE: file(url) });
      expect(r).toEqual({ status: 1, stdout: '', stderr: 'migration failed: set MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE, not both' });
      expect(await migrated(url)).toBe(false);
    });

    it('a blank URL is unset (the existing refusal); surrounding whitespace is removed; an unreadable file names the variable only', async () => {
      expect(run('migrate', [], { MIGRATION_DATABASE_URL: '   ' })).toEqual({ status: 1, stdout: '', stderr: REQUIRED });
      expect(run('migrate', [], { MIGRATION_DATABASE_URL_FILE: file('\n') })).toEqual({ status: 1, stdout: '', stderr: REQUIRED });
      const url = await database();
      expect(run('migrate', [], { MIGRATION_DATABASE_URL: `  ${url}  ` }).status).toBe(0);
      const missing = join(dir, `${SENTINEL}-absent`);
      expect(run('migrate', [], { MIGRATION_DATABASE_URL_FILE: missing }))
        .toEqual({ status: 1, stdout: '', stderr: 'migration failed: MIGRATION_DATABASE_URL_FILE is set but the file cannot be read' });
    });
  });

  describe('main.js', () => {
    it('BOOTSTRAP_OWNER_PASSWORD_FILE: the file content minus its line terminator, whitespace kept; that password authenticates', async () => {
      const password = ` ${SENTINEL} from file  `;
      const { url, env } = await bootstrapEnv({ BOOTSTRAP_OWNER_PASSWORD: undefined, BOOTSTRAP_OWNER_PASSWORD_FILE: file(`${password}\n`) });
      expect(run('main', ['bootstrap-owner'], env)).toEqual({ status: 0, stdout: 'owner created', stderr: '' });
      const hash = (await owner(url))!.passwordHash;
      expect(await bcrypt.compare(password, hash)).toBe(true);
      expect(await bcrypt.compare(`${password}\n`, hash)).toBe(false);
      expect(await bcrypt.compare(password.trim(), hash)).toBe(false);
    });

    it('the other BOOTSTRAP_* inputs accept NAME_FILE', async () => {
      const { url, env } = await bootstrapEnv({ BOOTSTRAP_COMPANY_NAME: undefined, BOOTSTRAP_OWNER_EMAIL: undefined, BOOTSTRAP_COMPANY_NAME_FILE: file('Acme Files\n'), BOOTSTRAP_OWNER_EMAIL_FILE: file('files@acme.test\n') });
      expect(run('main', ['bootstrap-owner'], env).status).toBe(0);
      expect(await company(url)).toEqual({ name: 'Acme Files' });
      expect((await owner(url))!.email).toBe('files@acme.test');
    });

    it.each(['BOOTSTRAP_OWNER_PASSWORD', 'BOOTSTRAP_COMPANY_NAME', 'BOOTSTRAP_OWNER_EMAIL'])('%s and its _FILE form together are refused; nothing is created', async (name) => {
      const { url, env } = await bootstrapEnv();
      const r = run('main', ['bootstrap-owner'], { ...env, [`${name}_FILE`]: file(env[name as keyof typeof env] as string) });
      expect(r).toEqual({ status: 1, stdout: '', stderr: `set ${name} or ${name}_FILE, not both` });
      expect(await owner(url)).toBeUndefined();
    });

    it('an unreadable BOOTSTRAP_OWNER_PASSWORD_FILE names the variable only', async () => {
      const { url, env } = await bootstrapEnv({ BOOTSTRAP_OWNER_PASSWORD: undefined, BOOTSTRAP_OWNER_PASSWORD_FILE: join(dir, `${SENTINEL}-absent`) });
      expect(run('main', ['bootstrap-owner'], env)).toEqual({ status: 1, stdout: '', stderr: 'BOOTSTRAP_OWNER_PASSWORD_FILE is set but the file cannot be read' });
      expect(await owner(url)).toBeUndefined();
    });

    it('a blank company name is refused (it was stored as given before)', async () => {
      const { url, env } = await bootstrapEnv({ BOOTSTRAP_COMPANY_NAME: '   ' });
      expect(run('main', ['bootstrap-owner'], env)).toEqual({ status: 1, stdout: '', stderr: 'BOOTSTRAP_COMPANY_NAME, BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD are required' });
      expect(await company(url)).toBeUndefined();
    });

    it('OD-A4.3-2: a configuration error is exactly one value-free line (no stack trace), exit 1', async () => {
      const r = run('main', ['check-totp-keys'], { ...serviceEnv(await database(inject('pgTemplate'))), JWT_SECRET: undefined, OPERATOR_CODE_PEPPER: SENTINEL });
      expect(r).toEqual({ status: 1, stdout: '', stderr: 'JWT_SECRET is required' });
    });

    it('an AUTH_EVENTS_FILE cannot override the forced off: the CLI runs and writes no domain event', async () => {
      const { url, env } = await bootstrapEnv({ AUTH_EVENTS_FILE: file('on\n') });
      const before = await domainEventRows(url);
      expect(run('main', ['bootstrap-owner'], env)).toEqual({ status: 0, stdout: 'owner created', stderr: '' });
      expect(await domainEventRows(url)).toBe(before);
    });
  });
});

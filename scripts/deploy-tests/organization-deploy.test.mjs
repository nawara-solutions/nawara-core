// Stage 21.x G1: apps/organization-service/deploy/provision-and-deploy.sh (G1.A), register-caller.sh (G1.C) and the Auth deploy's
// organization-service credential (G1.D), against the fake docker CLI. The real run is recorded in docs/runbooks/organization-production.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AUDIT_TOPOLOGY, ROOT, SCRIPTS, provisionedWorld, runOf } from './lib/harness.mjs';

const IMAGE = 'ghcr.io/nawara-solutions/nawara-core-organization-service:sha-test';
const APP = 'nawara-core-organization-service';
const DB = 'nawara-core-organization-db';
const NET = 'nawara-core-internal';
const orgWorld = () => provisionedWorld(['organization-service', 'auth-service'], AUDIT_TOPOLOGY);
const deploy = (w, env = {}) => w.run(SCRIPTS.organization, { IMAGE, ...env });
const dir = (w) => join(w.home, 'nawara-core/organization-service');
const read = (w, f) => readFileSync(join(dir(w), f), 'utf8');
const envVal = (text, key) => text.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
const mutations = (w) => w.state().calls.filter((a) => ['run', 'stop', 'rename', 'rm'].includes(a[0]) || (a[0] === 'network' && a[1] !== 'inspect'));
const noChange = (assertFn, w) => assertFn.deepEqual(mutations(w), [], 'a refused preflight must not create, stop or start anything');

// ---------------------------------------------------------------- G1.A: topology, roles before migrations, privilege assertion
test('happy path: private DB and service, roles BEFORE migrations, privileges asserted, no caller, PREPARED reported', () => {
  const w = orgWorld();
  const r = deploy(w);
  assert.equal(r.code, 0, r.out);
  const db = runOf(w, DB);
  assert.deepEqual(db.all('--network'), [NET]);
  assert.deepEqual([...db.all('-p'), ...db.all('--publish')], [], 'the database publishes no port');
  assert.deepEqual(db.all('-v'), ['nawara-core-organization-db-data:/var/lib/postgresql/data']);
  const app = runOf(w, APP);
  assert.deepEqual(app.all('--network'), [NET], 'internal network only: never deploy_edge');
  assert.deepEqual([...app.all('-p'), ...app.all('--publish')], [], 'no published port');
  assert.deepEqual(app.all('--label'), ['traefik.enable=false'], 'no Traefik route');
  assert.match(app.all('--health-cmd')[0], /127\.0\.0\.1:3000\/ready/, 'Docker health = /ready (database + migrations; not authority)');
  assert.deepEqual(app.all('--restart'), ['unless-stopped']);
  assert.deepEqual(app.all('--stop-timeout'), ['60']);
  assert.equal(app.image, IMAGE);

  const s = w.state();
  const rolesAt = s.stdin.find((x) => x.container === DB && x.text.includes('CREATE ROLE organization_app')).at;
  const defaultsAt = s.stdin.find((x) => x.container === DB && x.text.includes('ALTER DEFAULT PRIVILEGES FOR ROLE organization_migrator')).at;
  const migrateAt = s.calls.findIndex((a) => a[0] === 'run' && a.includes('--rm') && a.includes('../../libs/service-kit/dist/cli/migrate.js'));
  const assertAt = s.queries.find((q) => q.sql.includes('WHERE has_table_privilege')).at;
  const appAt = s.calls.findIndex((a) => a[0] === 'run' && a.includes('--name') && a[a.indexOf('--name') + 1] === APP);
  assert.ok(rolesAt < defaultsAt && defaultsAt < migrateAt, 'roles and default privileges exist BEFORE the migrations (0004/0005 narrow organization_app only if it exists)');
  assert.ok(migrateAt < assertAt && assertAt < appAt, 'privileges are asserted AFTER migrating and BEFORE the service starts');
  assert.deepEqual(s.calls[migrateAt].slice(-3), ['../../libs/service-kit/dist/cli/migrate.js', '--dir', 'db/migrations']);
  assert.ok(s.calls[migrateAt].includes(NET) && s.calls[migrateAt].includes(IMAGE), 'migrations run from THIS image on the private network');

  const env = read(w, '.env');
  assert.match(env, /^DATABASE_URL=postgres:\/\/organization_app:[0-9a-f]{48}@nawara-core-organization-db:5432\/organization$/m, 'runtime = organization_app');
  assert.equal(envVal(env, 'AUTH_SERVICE_URL'), 'http://nawara-core-auth-service:3000');
  assert.equal(envVal(env, 'NODE_ENV'), 'production');
  assert.equal(`RABBITMQ_URL=${envVal(env, 'RABBITMQ_URL')}`, readFileSync(join(w.home, 'nawara-core/rabbitmq/clients/organization-service.env'), 'utf8').trim(), 'the organization-service broker identity');
  assert.doesNotMatch(env, /SERVICE_TOKENS|SERVICE_POLICY|OWNERSHIP_/, 'no caller is registered and no ownership setting is written by a deploy');
  assert.equal(existsSync(join(dir(w), 'callers')), false, 'no caller token is created by a deploy');
  for (const f of ['.env', 'db.env', 'roles.env']) assert.equal(w.mode(join(dir(w), f)), '600');
  assert.equal(w.mode(dir(w)), '700');
  assert.match(r.out, /ownership phase PREPARED, environment class undeclared \(deploying never changes it\)/);
});

test('the role SQL makes organization_app least-privilege and never re-grants on existing tables', () => {
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  const sql = w.state().stdin.filter((x) => x.container === DB).map((x) => x.text).join('\n');
  assert.match(sql, /ALTER ROLE organization_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD/);
  assert.match(sql, /CREATE DATABASE organization OWNER organization_migrator/);
  assert.doesNotMatch(sql, /ON ALL TABLES/, 'a blanket grant would undo the 0004/0005 revokes');
  const migrate = w.state().calls.find((a) => a[0] === 'run' && a.includes('--rm'));
  const envFile = migrate[migrate.indexOf('--env-file') + 1];
  assert.match(envFile, /\.migrate\./, 'the migrator URL travels in a temporary env file, never on the command line');
  assert.equal(existsSync(envFile), false, 'the temporary migrator env file is removed');
});

for (const [label, org, reason] of [
  ['organization_app can UPDATE ownership_state (revokes skipped)', { forbidden: 'ownership_state:UPDATE' }, /forbidden privileges \(ownership_state:UPDATE\)/],
  ['organization_app can DELETE the hierarchy', { forbidden: 'company:DELETE,organization:TRUNCATE' }, /forbidden privileges/],
  ['organization_app is a superuser', { roleAttrs: 't|f|f|f|f' }, /elevated attribute/],
  ['organization_app has BYPASSRLS', { roleAttrs: 'f|f|f|f|t' }, /elevated attribute/],
  ['organization_app cannot read the ownership state', { missing: 'ownership_state:SELECT' }, /lacks privileges the service needs/],
]) {
  test(`fail closed when ${label}: the service is never started or swapped`, () => {
    const w = orgWorld();
    w.patch((s) => { s.org = org; });
    const r = deploy(w);
    assert.notEqual(r.code, 0);
    assert.match(r.out, reason);
    assert.match(r.out, /the running service was not touched/);
    assert.equal(runOf(w, APP), undefined, 'no organization-service container was started');
  });
}

test('over-privileged on a REDEPLOY: the running service keeps running, nothing is swapped', () => {
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  const id = w.state().containers[APP].id;
  w.patch((s) => { s.org = { forbidden: 'ownership_state:INSERT' }; });
  assert.notEqual(deploy(w).code, 0);
  assert.equal(w.state().containers[APP].id, id);
  assert.equal(w.state().containers[APP].running, true);
  assert.deepEqual(w.calls('stop'), []);
});

// ---------------------------------------------------------------- the migration history is the migrator's alone (G2/G3)
const HISTORY_WRITES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

test('the migration history is made read-only for organization_app after migrating, and asserted before the service starts', () => {
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  const s = w.state();
  const narrow = s.stdin.find((x) => x.container === DB && x.text.includes('schema_migrations'));
  assert.ok(narrow, 'schema_migrations is narrowed by the deploy');
  assert.deepEqual(narrow.text.trim().split('\n'), [
    'REVOKE ALL ON TABLE schema_migrations FROM organization_app;',
    'GRANT SELECT ON TABLE schema_migrations TO organization_app;',
  ], 'SELECT only (for /ready), nothing else');
  assert.equal(s.calls[narrow.at][s.calls[narrow.at].indexOf('-d') + 1], 'organization');
  const migrateAt = s.calls.findIndex((a) => a[0] === 'run' && a.includes('../../libs/service-kit/dist/cli/migrate.js'));
  const forbiddenQ = s.queries.find((q) => q.sql.includes('WHERE has_table_privilege'));
  const missingQ = s.queries.find((q) => q.sql.includes('WHERE NOT has_table_privilege'));
  const appAt = s.calls.findIndex((a) => a[0] === 'run' && a.includes('--name') && a[a.indexOf('--name') + 1] === APP);
  assert.ok(migrateAt < narrow.at && narrow.at < forbiddenQ.at && forbiddenQ.at < appAt,
    'the runner creates schema_migrations, so it is narrowed after migrating, then asserted, then the service starts');
  for (const p of HISTORY_WRITES) assert.ok(forbiddenQ.sql.includes(`('schema_migrations','${p}')`), `the assertion forbids schema_migrations ${p}`);
  assert.ok(missingQ.sql.includes("('schema_migrations','SELECT')"), 'the assertion requires schema_migrations SELECT (/ready reads it)');
});

for (const p of HISTORY_WRITES) {
  test(`fail closed when organization_app can ${p} schema_migrations: first deploy never starts, a redeploy never swaps`, () => {
    const first = orgWorld();
    first.patch((s) => { s.org = { forbidden: `schema_migrations:${p}` }; });
    const r = deploy(first);
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp(`forbidden privileges \\(schema_migrations:${p}\\).*the running service was not touched`));
    assert.equal(runOf(first, APP), undefined, 'no organization-service container was started');

    const again = orgWorld();
    assert.equal(deploy(again).code, 0);
    const id = again.state().containers[APP].id;
    again.patch((s) => { s.org = { forbidden: `schema_migrations:${p}` }; });
    assert.notEqual(deploy(again).code, 0);
    assert.equal(again.state().containers[APP].id, id, 'the running service is the same container');
    assert.equal(again.state().containers[APP].running, true);
    assert.deepEqual(again.calls('stop'), []);
  });
}

test('fail closed when organization_app cannot read schema_migrations (/ready needs it): the service is never started', () => {
  const w = orgWorld();
  w.patch((s) => { s.org = { missing: 'schema_migrations:SELECT' }; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /lacks privileges the service needs \(schema_migrations:SELECT\)/);
  assert.equal(runOf(w, APP), undefined);
});

// ---------------------------------------------------------------- deploying is not activating
test('a deploy runs no ownership command, sets no activation gate, registers no caller and never touches Auth', () => {
  const w = orgWorld();
  const r = deploy(w);
  assert.equal(r.code, 0);
  const everything = JSON.stringify(w.state().calls) + JSON.stringify(w.state().stdin) + JSON.stringify(w.state().queries);
  for (const forbidden of ['ownership.js', 'declare-class', 'approve', 'activate', 'retire', 'OWNERSHIP_PRODUCTION_ACTIVATION', 'ACTIVATE-AUTHORITY', 'register-caller', 'SERVICE_TOKENS']) {
    assert.ok(!everything.includes(forbidden), `deploy must never involve ${forbidden}`);
  }
  assert.ok(!everything.includes('nawara-core-auth-service '), 'Auth is not touched');
  const touched = new Set(w.state().calls.filter((a) => ['run', 'stop', 'rename', 'rm'].includes(a[0]) && !a.includes('--rm')).map((a) => (a.includes('--name') ? a[a.indexOf('--name') + 1] : a.at(-1))));
  for (const n of touched) assert.ok(n.startsWith('nawara-core-organization'), `only Organization containers are touched (got ${n})`);
  assert.equal(w.state().queries.filter((q) => /UPDATE|INSERT|DELETE/i.test(q.sql.replace(/'[^']*'/g, ''))).length, 0, 'the phase report is read-only');
});

test('secret-safe: no generated secret in the output or in any docker argv', () => {
  const w = orgWorld();
  const r = deploy(w);
  assert.equal(r.code, 0);
  const argv = JSON.stringify(w.state().calls);
  const secrets = w.secrets();
  assert.ok(secrets.length >= 5);
  for (const s of secrets) {
    assert.ok(!r.out.includes(s), 'a secret was printed');
    assert.ok(!argv.includes(s), 'a secret was passed on a command line');
  }
});

// ---------------------------------------------------------------- rollback, idempotency, preflight refusals
test('an unhealthy replacement is removed and the previous container restored', () => {
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  const first = w.state().containers[APP].id;
  w.patch((s) => { s.healthOf = { [APP]: 'unhealthy' }; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /rolling back to nawara-core-organization-service-previous-/);
  assert.equal(w.state().containers[APP].id, first);
  assert.equal(w.state().containers[APP].running, true);
});

test('a replacement that somehow publishes a port breaks the exposure contract and is rolled back', () => {
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  w.patch((s) => { s.injectPorts = { [APP]: ['0.0.0.0:3000:3000'] }; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /breaks the exposure contract \(state: publishes a host port\)/);
});

test('idempotent: a rerun keeps every secret and the database container, and keeps the previous service for rollback', () => {
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  const secrets = w.secrets().sort();
  const dbId = w.state().containers[DB].id;
  const r = deploy(w);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /\(new\)/);
  assert.deepEqual(w.secrets().sort(), secrets);
  assert.equal(w.state().containers[DB].id, dbId, 'the database container is never recreated');
  assert.match(r.out, /previous container kept stopped as nawara-core-organization-service-previous-/);
});

test('failing migrations stop the deploy before the running service is touched', () => {
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  w.patch((s) => { s.failRm = { [IMAGE]: true }; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /migrations failed or were refused; the running service was not touched/);
  assert.deepEqual(w.calls('stop'), []);
});

test('preflight: no organization-service broker identity -> refused, nothing changed', () => {
  const w = provisionedWorld(['audit-service', 'auth-service'], AUDIT_TOPOLOGY);
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /broker identity for organization-service is missing.*nothing was changed/);
  noChange(assert, w);
});

test('preflight: no --internal Core network -> refused, nothing changed', () => {
  const w = orgWorld();
  w.patch((s) => { s.networks[NET].internal = false; });
  assert.match(deploy(w).out, /does not exist \(or is not --internal\).*nothing was changed/);
  noChange(assert, w);
});

test('preflight: broker not ready -> refused, nothing changed', () => {
  const w = orgWorld();
  w.patch((s) => { s.broker.ready = false; });
  assert.match(deploy(w).out, /broker nawara-core-rabbitmq is not running or not ready; nothing was changed/);
  noChange(assert, w);
});

test('an existing database container without its role file is never guessed', () => {
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  rmSync(join(dir(w), 'roles.env'));
  assert.match(deploy(w).out, /exists but .*roles\.env is missing; refusing to guess the role passwords/);
});

// ---------------------------------------------------------------- G1.C: caller registration (an explicit operator step)
const register = (w, caller, confirm = `register ${caller}`) => w.run(SCRIPTS.registerCaller, { CALLER: caller, CONFIRM: confirm });
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

test('registration refuses without the exact typed confirmation, an unknown caller, or before a deploy', () => {
  const w = orgWorld();
  assert.match(register(w, 'provisioning').out, /\.env is missing: deploy organization-service first; nothing was changed/);
  assert.equal(deploy(w).code, 0);
  const before = read(w, '.env');
  assert.match(register(w, 'provisioning', 'yes').out, /CONFIRM must be exactly "register provisioning"; nothing was changed/);
  assert.match(register(w, 'billing-service').out, /unknown caller 'billing-service'.*nothing was changed/);
  assert.equal(read(w, '.env'), before);
  assert.equal(existsSync(join(dir(w), 'callers/provisioning.token')), false);
});

test('F1 provisioning, then F4 auth-service: server-side tokens, digests and least-privilege policy; never printed; never rotated', () => {
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  const r1 = register(w, 'provisioning');
  assert.equal(r1.code, 0, r1.out);
  const prov = readFileSync(join(dir(w), 'callers/provisioning.token'), 'utf8').trim();
  assert.match(prov, /^[0-9a-f]{64}$/);
  assert.equal(w.mode(join(dir(w), 'callers/provisioning.token')), '600');
  assert.equal(w.mode(join(dir(w), 'callers')), '700');
  assert.equal(envVal(read(w, '.env'), 'SERVICE_TOKENS'), `provisioning:${sha(prov)}`);
  assert.equal(envVal(read(w, '.env'), 'SERVICE_POLICY'), '{"callers":{"provisioning":{"capabilities":["hierarchy.provision"]}}}');
  const r2 = register(w, 'auth-service');
  assert.equal(r2.code, 0, r2.out);
  const auth = readFileSync(join(dir(w), 'callers/auth-service.token'), 'utf8').trim();
  assert.equal(envVal(read(w, '.env'), 'SERVICE_TOKENS'), `auth-service:${sha(auth)},provisioning:${sha(prov)}`);
  assert.equal(envVal(read(w, '.env'), 'SERVICE_POLICY'),
    '{"callers":{"auth-service":{"capabilities":["hierarchy.read"],"allowedPlatforms":[]},"provisioning":{"capabilities":["hierarchy.provision"]}}}');
  const r3 = register(w, 'auth-service');
  assert.equal(r3.code, 0);
  assert.equal(readFileSync(join(dir(w), 'callers/auth-service.token'), 'utf8').trim(), auth, 'an existing token is never rotated here');
  for (const out of [r1.out, r2.out, r3.out]) for (const t of [prov, auth]) assert.ok(!out.includes(t), 'a raw token was printed');
  assert.match(read(w, '.env'), /^DATABASE_URL=/m, 'the rest of .env is kept');
  assert.equal(w.mode(join(dir(w), '.env')), '600');
});

test('the registered configuration is accepted by organization-service itself (its own parsers)', (t) => {
  const req = createRequire(join(ROOT, 'package.json'));
  const policyJs = join(ROOT, 'apps/organization-service/dist/authorization/service-policy.js');
  const kitJs = join(ROOT, 'libs/service-kit/dist/index.js');
  if (!existsSync(policyJs) || !existsSync(kitJs)) { t.skip('organization-service / service-kit not built (dist/); run their build to include this check'); return; }
  const w = orgWorld();
  assert.equal(deploy(w).code, 0);
  assert.equal(register(w, 'provisioning').code, 0);
  assert.equal(register(w, 'auth-service').code, 0);
  const { ServicePolicy } = req(policyJs);
  const { parseServiceTokens } = req(kitJs);
  const tokens = parseServiceTokens(envVal(read(w, '.env'), 'SERVICE_TOKENS'));
  const policy = ServicePolicy.parse(envVal(read(w, '.env'), 'SERVICE_POLICY'), [...new Set(tokens.map((x) => x.caller))]);
  assert.equal(policy.has('provisioning', 'hierarchy.provision'), true);
  assert.equal(policy.has('auth-service', 'hierarchy.read'), true);
  assert.equal(policy.has('auth-service', 'hierarchy.provision'), false, 'Auth never provisions');
  assert.equal(policy.has('auth-service', 'hierarchy.write'), false, 'Auth never writes the hierarchy');
  assert.deepEqual([...policy.platforms('auth-service')], [], 'no Platform yet');
});

// ---------------------------------------------------------------- G1.D: Auth receives the credential, never the authority switch
const IMAGE_AUTH = 'ghcr.io/nawara-solutions/nawara-core-auth-service:sha-test';
function authWorld(withToken) {
  const w = provisionedWorld(['audit-service', 'auth-service', 'organization-service'], AUDIT_TOPOLOGY);
  if (withToken) {
    mkdirSync(join(w.home, 'nawara-core/organization-service/callers'), { recursive: true, mode: 0o700 });
    writeFileSync(join(w.home, 'nawara-core/organization-service/callers/auth-service.token'), `${'7c'.repeat(32)}\n`, { mode: 0o600 });
  }
  return w;
}
const authEnv = (w) => readFileSync(join(w.home, 'nawara-core/auth-service/.env'), 'utf8');

test('Auth deploy before F4: no organization-service setting at all; the hierarchy source stays local (unset)', () => {
  const w = authWorld(false);
  const r = w.run(SCRIPTS.auth, { IMAGE: IMAGE_AUTH });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(authEnv(w), /ORGANIZATION_SERVICE_|AUTH_HIERARCHY_SOURCE/);
});

test('Auth deploy after F4: URL and token together, from the server-side caller file; the source is NOT switched; token never printed', () => {
  const w = authWorld(true);
  const r = w.run(SCRIPTS.auth, { IMAGE: IMAGE_AUTH });
  assert.equal(r.code, 0, r.out);
  const env = authEnv(w);
  assert.equal(envVal(env, 'ORGANIZATION_SERVICE_URL'), 'http://nawara-core-organization-service:3000');
  assert.equal(envVal(env, 'ORGANIZATION_SERVICE_TOKEN'), '7c'.repeat(32));
  assert.doesNotMatch(env, /AUTH_HIERARCHY_SOURCE/, 'F6 (the mirror) switches the source; a deploy never does');
  assert.ok(!r.out.includes('7c'.repeat(32)) && !JSON.stringify(w.state().calls).includes('7c'.repeat(32)), 'the token was printed or passed on a command line');
});

test('Auth deploy keeps an operator-set hierarchy source and never overwrites an existing organization-service value', () => {
  const w = authWorld(true);
  mkdirSync(join(w.home, 'nawara-core/auth-service'), { recursive: true });
  writeFileSync(join(w.home, 'nawara-core/auth-service/.env'), 'AUTH_HIERARCHY_SOURCE=local\nORGANIZATION_SERVICE_URL=http://operator-set:3000\n', { mode: 0o600 });
  assert.equal(w.run(SCRIPTS.auth, { IMAGE: IMAGE_AUTH }).code, 0);
  const env = authEnv(w);
  assert.equal(envVal(env, 'AUTH_HIERARCHY_SOURCE'), 'local');
  assert.equal(envVal(env, 'ORGANIZATION_SERVICE_URL'), 'http://operator-set:3000');
});

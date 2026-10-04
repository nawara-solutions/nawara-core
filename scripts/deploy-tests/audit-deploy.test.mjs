// apps/audit-service/deploy/provision-and-deploy.sh against the fake docker CLI (ADR-0053).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_TOPOLOGY, SCRIPTS, assertNothingChanged, provisionedWorld, runOf } from './lib/harness.mjs';

const IMAGE = 'ghcr.io/nawara-solutions/nawara-core-audit-service:sha-test';
const APP = 'nawara-core-audit-service';
const DB = 'nawara-core-audit-db';
const deploy = (w, env = {}) => w.run(SCRIPTS.audit, { IMAGE, ...env });
const ready = (extra = {}) => provisionedWorld(['audit-service', 'auth-service'], { ...AUDIT_TOPOLOGY, ...extra });

test('happy path: private database, migrations as audit_migrator, private service, broker identity, verified topology', () => {
  const w = ready();
  const r = deploy(w);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK {2}nawara-core-audit-service is running\/healthy; audit-service\.audit is declared, bound to audit\.# and consumed/);

  const db = runOf(w, DB);
  assert.deepEqual(db.all('--network'), ['nawara-core-internal'], 'the audit database is private');
  assert.deepEqual([...db.all('-p'), ...db.all('--publish')], []);
  assert.deepEqual(db.all('-v'), ['nawara-core-audit-db-data:/var/lib/postgresql/data']);

  const migrate = w.calls('run', '--rm').at(-1);
  assert.ok(migrate.includes('nawara-core-internal') && migrate.includes(IMAGE), 'migrations run from THIS image on the private network');
  assert.deepEqual(migrate.slice(-3), ['../../libs/service-kit/dist/cli/migrate.js', '--dir', 'db/migrations']);

  const app = runOf(w, APP);
  assert.deepEqual(app.all('--network'), ['nawara-core-internal'], 'audit-service is never on deploy_edge');
  assert.deepEqual([...app.all('-p'), ...app.all('--publish')], []);
  assert.deepEqual(app.all('--label'), ['traefik.enable=false'], 'no Traefik route: Audit has no public reader');
  assert.match(app.all('--health-cmd')[0], /127\.0\.0\.1:3000\/ready/, 'healthy = database, migrations, broker AND the consumer attached');
  assert.equal(app.image, IMAGE);

  const env = readFileSync(join(w.home, 'nawara-core/audit-service/.env'), 'utf8');
  const client = readFileSync(join(w.home, 'nawara-core/rabbitmq/clients/audit-service.env'), 'utf8').trim();
  assert.ok(env.includes(`${client}\n`), 'RABBITMQ_URL is the broker-provisioned audit-service identity');
  assert.match(env, /^DATABASE_URL=postgres:\/\/audit_app:[0-9a-f]{48}@nawara-core-audit-db:5432\/audit$/m, 'the runtime role, never the owner');
  assert.match(env, /^NODE_ENV=production$/m);
  assert.doesNotMatch(env, /SERVICE_TOKENS|AUDIT_SERVICE_POLICY/, 'no reader is configured: every read is refused by default');
  assert.equal(w.mode(join(w.home, 'nawara-core/audit-service/.env')), '600');
});

test('database roles follow ADR-0032: owner migrator, runtime app, default privileges only (append-only is never re-granted away)', () => {
  const w = ready();
  assert.equal(deploy(w).code, 0);
  const sql = w.state().stdin.filter((s) => s.container === DB).map((s) => s.text).join('\n');
  assert.match(sql, /CREATE DATABASE audit OWNER audit_migrator/);
  assert.match(sql, /ALTER ROLE audit_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE audit_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO audit_app/);
  assert.doesNotMatch(sql, /ON ALL TABLES/, 'a blanket grant would undo migration 0001 (audit_restrict_to_append_only)');
  assert.doesNotMatch(sql, /audit_retention/, 'no retention role until retention durations are decided (P-A2)');
  assert.ok(!JSON.stringify(w.state().calls).includes('PASSWORD'), 'role passwords travel on stdin, never on a command line');
});

test('secret-safe: no generated secret in the output or in any docker argv', () => {
  const w = ready();
  const r = deploy(w);
  assert.equal(r.code, 0);
  const argv = JSON.stringify(w.state().calls);
  for (const s of w.secrets()) {
    assert.ok(!r.out.includes(s), 'a secret was printed');
    assert.ok(!argv.includes(s), 'a secret was passed on a command line');
  }
});

test('preflight: no internal Core network -> refused, nothing changed', () => {
  const w = ready();
  w.patch((s) => { delete s.networks['nawara-core-internal']; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /internal Core network 'nawara-core-internal' does not exist.*nothing was changed/);
  assertNothingChanged(assert, w);
});

test('preflight: a Core network that is not --internal -> refused, nothing changed', () => {
  const w = ready();
  w.patch((s) => { s.networks['nawara-core-internal'].internal = false; });
  assert.notEqual(deploy(w).code, 0);
  assertNothingChanged(assert, w);
});

test('preflight: broker not ready -> refused, nothing changed', () => {
  const w = ready({ ready: false });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /broker nawara-core-rabbitmq is not running or not ready.*nothing was changed/);
  assertNothingChanged(assert, w);
});

test('preflight: no audit-service broker identity -> refused, nothing changed (never a default or guest credential)', () => {
  const w = ready();
  rmSync(join(w.home, 'nawara-core/rabbitmq/clients/audit-service.env'));
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /broker identity for audit-service is missing.*nothing was changed/);
  assertNothingChanged(assert, w);
});

test('failing migrations stop the deploy before the running service is touched', () => {
  const w = ready();
  assert.equal(deploy(w).code, 0);
  w.patch((s) => { s.failRm = { [IMAGE]: true }; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /migrations failed or were refused; the running service was not touched/);
  assert.equal(w.state().containers[APP].running, true);
  assert.deepEqual(w.calls('stop'), []);
});

test('an audit consumer that never becomes ready (e.g. queue declared with other arguments) is rolled back', () => {
  const w = ready();
  assert.equal(deploy(w).code, 0);
  const firstId = w.state().containers[APP].id;
  w.patch((s) => { s.healthOf = { [APP]: 'unhealthy' }; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /rolling back to nawara-core-audit-service-previous-/);
  assert.equal(w.state().containers[APP].id, firstId, 'the previous container is back under its name');
  assert.equal(w.state().containers[APP].running, true);
});

for (const [label, topology, reason] of [
  ['the audit binding is missing', { bindings: AUDIT_TOPOLOGY.bindings.replace(/.*audit\.#\n/, '') }, /binding nawara\.events -> audit-service\.audit \(audit\.#\) missing/],
  ['the work queue has no dead-letter exchange', { queues: AUDIT_TOPOLOGY.queues.replace('[{"x-dead-letter-exchange","nawara.events.dlx"}]', '[]') }, /not declared as expected/],
  ['the work queue has no consumer', { queues: AUDIT_TOPOLOGY.queues.replace(/\t1\n/, '\t0\n') }, /not declared as expected or has no consumer/],
  ['the dead-letter queue is missing', { queues: AUDIT_TOPOLOGY.queues.replace(/audit-service\.audit\.dead.*\n/, '') }, /\.dead missing/],
]) {
  test(`a healthy container is still a FAILED deploy when ${label} (verified on the broker)`, () => {
    const w = ready(topology);
    const r = deploy(w);
    assert.notEqual(r.code, 0);
    assert.match(r.out, reason);
    assert.match(r.out, /deploy failed/);
  });
}

// V2 A0: the manual deployment passes an exact INDEX digest reference (IMAGE_NAME@sha256:…), never a tag. The script, unchanged, must
// use exactly that reference for the migrations and for the new container, migrate before the swap, keep the /ready health gate and
// the previous container.
const DIGEST_IMAGE = `ghcr.io/nawara-solutions/nawara-core-audit-service@sha256:${'ef56'.repeat(16)}`;

test('digest deployment: migrations and the new container use exactly IMAGE_NAME@digest; migrations run before the swap', () => {
  const w = ready();
  assert.equal(deploy(w).code, 0);
  const before = w.state().calls.length;
  const r = deploy(w, { IMAGE: DIGEST_IMAGE });
  assert.equal(r.code, 0, r.out);
  const calls = w.state().calls.slice(before);
  const images = calls.filter((a) => a[0] === 'run').map((a) => a.find((x) => x.includes('nawara-core-audit-service@') || x.includes('nawara-core-audit-service:'))).filter(Boolean);
  assert.deepEqual([...new Set(images)], [DIGEST_IMAGE], 'no tag and no other image is ever run');
  const migrateAt = calls.findIndex((a) => a[0] === 'run' && a.includes('../../libs/service-kit/dist/cli/migrate.js'));
  const stopAt = calls.findIndex((a) => a[0] === 'stop' && a.includes(APP));
  assert.ok(migrateAt >= 0 && stopAt > migrateAt, 'migrations run before the running service is stopped');
  const app = runOf(w, APP);
  assert.equal(app.image, DIGEST_IMAGE);
  assert.match(app.all('--health-cmd')[0], /127\.0\.0\.1:3000\/ready/, 'the /ready health gate is unchanged');
  assert.ok(Object.keys(w.state().containers).some((n) => n.startsWith(`${APP}-previous-`)), 'the previous container is retained');
});

test('digest deployment: a failed migration stops the deploy before the running service is touched', () => {
  const w = ready();
  assert.equal(deploy(w).code, 0);
  const running = w.state().containers[APP].id;
  w.patch((s) => { s.failRm = { [DIGEST_IMAGE]: true }; });
  const before = w.state().calls.length;
  const r = deploy(w, { IMAGE: DIGEST_IMAGE });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /migrations failed or were refused; the running service was not touched/);
  const after = w.state().calls.slice(before);
  assert.deepEqual(after.filter((a) => (['stop', 'rename', 'start'].includes(a[0]) && a.includes(APP)) || (a[0] === 'run' && a.includes('-d') && a.includes('--name') && a[a.indexOf('--name') + 1] === APP)), [],
    'the application container is not stopped, renamed, replaced or started');
  assert.equal(w.state().containers[APP].id, running);
});

// V2 A13 (O3-B): the migration history is the migrator's alone. The runner creates schema_migrations as audit_migrator, so the default
// privileges give audit_app DML on it; the deploy narrows it to SELECT after migrating and asserts the runtime role before any start.
const HISTORY_WRITES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

test('the migration history is made read-only for audit_app after migrating, and asserted before the service starts', () => {
  const w = ready();
  assert.equal(deploy(w).code, 0);
  const s = w.state();
  const narrow = s.stdin.find((x) => x.container === DB && x.text.includes('schema_migrations'));
  assert.ok(narrow, 'schema_migrations is narrowed by the deploy');
  assert.deepEqual(narrow.text.trim().split('\n'), [
    'REVOKE ALL ON TABLE schema_migrations FROM audit_app;',
    'GRANT SELECT ON TABLE schema_migrations TO audit_app;',
  ], 'SELECT only (for /ready), nothing else');
  assert.equal(s.calls[narrow.at][s.calls[narrow.at].indexOf('-d') + 1], 'audit');
  const migrate = s.calls.findIndex((a) => a[0] === 'run' && a.includes('../../libs/service-kit/dist/cli/migrate.js'));
  assert.match(s.calls.find((a) => a[0] === 'run' && a.includes('--rm')).join(' '), /--env-file \S+\/\.migrate\.\S+ --entrypoint node/);
  const attrsQ = s.queries.find((q) => q.sql.includes('rolbypassrls'));
  const forbiddenQ = s.queries.find((q) => q.sql.includes('WHERE has_table_privilege'));
  const missingQ = s.queries.find((q) => q.sql.includes('WHERE NOT has_table_privilege'));
  const appAt = s.calls.findIndex((a) => a[0] === 'run' && a.includes('--name') && a[a.indexOf('--name') + 1] === APP);
  assert.ok(migrate < narrow.at && narrow.at < attrsQ.at && attrsQ.at < forbiddenQ.at && forbiddenQ.at < missingQ.at && missingQ.at < appAt,
    'migrate, then narrow, then assert, then (only then) start the service');
  for (const p of HISTORY_WRITES) assert.ok(forbiddenQ.sql.includes(`('schema_migrations','${p}')`), `the assertion forbids schema_migrations ${p}`);
  for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) assert.ok(forbiddenQ.sql.includes(`('audit_record','${p}')`), `the assertion forbids audit_record ${p}`);
  for (const t of ['audit_retention_run', 'audit_retention_policy']) for (const p of HISTORY_WRITES) assert.ok(forbiddenQ.sql.includes(`('${t}','${p}')`), `the assertion forbids ${t} ${p}`);
  for (const f of ['audit_grant_retention(regrole)', 'audit_restrict_to_append_only(regclass)']) assert.ok(forbiddenQ.sql.includes(`('${f}')`) && forbiddenQ.sql.includes('has_function_privilege'), `the assertion forbids EXECUTE on ${f}`);
  for (const r of ["('schema_migrations','SELECT')", "('audit_record','SELECT')", "('audit_record','INSERT')"]) assert.ok(missingQ.sql.includes(r), `the assertion requires ${r}`);
  assert.ok(!s.stdin.some((x) => /ALTER DEFAULT PRIVILEGES[^;]*REVOKE/i.test(x.text)), 'the general default privileges are not changed');
});

test('migrations still run as audit_migrator (the owner), never as the runtime role', () => {
  const w = ready();
  assert.equal(deploy(w).code, 0);
  const sql = w.state().stdin.filter((s) => s.container === DB).map((s) => s.text).join('\n');
  assert.match(sql, /CREATE DATABASE audit OWNER audit_migrator/);
  const migrate = w.calls('run', '--rm').at(-1);
  assert.ok(migrate.includes('--entrypoint') && migrate.includes('node'));
  assert.ok(!JSON.stringify(migrate).includes('audit_app'), 'the migration runner is not handed the runtime identity');
});

for (const p of HISTORY_WRITES) {
  test(`fail closed when audit_app can ${p} schema_migrations: a first deploy never starts, a redeploy never swaps`, () => {
    const first = ready();
    first.patch((s) => { s.audit = { forbidden: `schema_migrations:${p}` }; });
    const r = deploy(first);
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp(`forbidden privileges \\(schema_migrations:${p}\\).*the running service was not touched`));
    assert.equal(runOf(first, APP), undefined, 'no audit-service container was started');

    const again = ready();
    assert.equal(deploy(again).code, 0);
    const id = again.state().containers[APP].id;
    again.patch((s) => { s.audit = { forbidden: `schema_migrations:${p}` }; });
    assert.notEqual(deploy(again).code, 0);
    assert.equal(again.state().containers[APP].id, id, 'the running container is untouched');
    assert.equal(again.state().containers[APP].running, true);
    assert.deepEqual(again.calls('stop'), []);
  });
}

for (const [label, audit, reason] of [
  ['audit_app can run the retention grant helper', { forbidden: 'audit_grant_retention(regrole):EXECUTE' }, /forbidden privileges \(audit_grant_retention\(regrole\):EXECUTE\)/],
  ['audit_app can rewrite evidence', { forbidden: 'audit_record:UPDATE' }, /forbidden privileges \(audit_record:UPDATE\)/],
  ['audit_app can no longer read the migration history (/ready)', { missing: 'schema_migrations:SELECT' }, /lacks privileges the service needs \(schema_migrations:SELECT\)/],
  ['audit_app has an elevated attribute', { roleAttrs: 't|f|f|f|f' }, /audit_app has an elevated attribute/],
]) {
  test(`fail closed when ${label}: the service is never started`, () => {
    const w = ready();
    w.patch((s) => { s.audit = audit; });
    const r = deploy(w);
    assert.notEqual(r.code, 0);
    assert.match(r.out, reason);
    assert.match(r.out, /the running service was not touched/);
    assert.equal(runOf(w, APP), undefined);
  });
}

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

// apps/auth-service/deploy/rotate-db-credential.sh against the fake docker CLI and its simulated PostgreSQL. The same tool was also run
// for real on local Docker against the production-era Auth image (see docs/runbooks/auth-db-credential-rotation.md, "Validation").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_TOPOLOGY, AUTH_IMAGE_ID, SCRIPTS, rotationWorld } from './lib/harness.mjs';

const APP = 'nawara-core-auth-service';
const read = (w, f) => readFileSync(join(w.dir, f), 'utf8');
const envVal = (text, key) => text.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
const urlPass = (url) => url.match(/^postgres:\/\/auth_app:([^@]*)@/)[1];
const role = (w) => w.state().pg.roles.auth_app.password;
const ns = (times) => times.split(' ').map((t, k) => (k === 2 ? t : String(Number(t.replace(/ns$|s$/, '')) * (t.endsWith('ns') ? 1 : 1e9)))).join(' ');
const fileOrNull = (w, f) => (existsSync(join(w.dir, f)) ? read(w, f) : null);
const before = (w) => ({ role: role(w), dbEnv: fileOrNull(w, 'db.env'), appEnv: fileOrNull(w, '.env') });
/** Nothing changed: no container/network mutation, no SQL sent on stdin (read-only `psql -c` checks are fine), role and files as before. */
function unchanged(w, was) {
  const mutating = w.state().calls.filter((a) => ['run', 'stop', 'rename', 'rm', 'start', 'pull', 'build'].includes(a[0]) || (a[0] === 'network' && a[1] !== 'inspect'));
  assert.deepEqual(mutating, [], 'a refused preflight must not touch any container or network');
  assert.deepEqual(w.state().stdin, [], 'no SQL may be sent');
  assert.equal(role(w), was.role, 'the role password is unchanged');
  assert.equal(fileOrNull(w, 'db.env'), was.dbEnv, 'db.env is unchanged');
  assert.equal(fileOrNull(w, '.env'), was.appEnv, '.env is unchanged');
  assert.equal(existsSync(join(w.dir, '.rotation-journal')), false);
}

test('rotation: all three sources move to ONE fresh password, Auth is recreated from the same image and config, the old password is dead', () => {
  const w = rotationWorld();
  const before = w.state().containers[APP];
  const r = w.rotate();
  assert.equal(r.code, 0, r.out);
  const now = role(w);
  assert.match(now, /^[0-9a-f]{64}$/, 'a 256-bit hex secret: nothing to URI-encode');
  assert.notEqual(now, w.old);
  assert.equal(envVal(read(w, 'db.env'), 'AUTH_APP_PASSWORD'), now, 'db.env (what the next deploy re-applies) holds the new password');
  assert.equal(urlPass(envVal(read(w, '.env'), 'DATABASE_URL')), now, '.env holds the new password');
  assert.equal(envVal(read(w, '.env'), 'DATABASE_URL'), `postgres://auth_app:${now}@nawara-core-auth-db:5432/auth`, 'only the password component changed');
  const after = w.state().containers[APP];
  assert.equal(after.imageId, AUTH_IMAGE_ID, 'the SAME image ID (never :production, never pulled)');
  assert.equal(after.image, AUTH_IMAGE_ID);
  assert.equal(after.pull, 'never');
  assert.deepEqual([...after.labels].sort(), [...before.labels].sort(), 'labels (Traefik routing) preserved');
  assert.deepEqual(Object.keys(after.networks), Object.keys(before.networks), 'networks preserved');
  assert.equal(after.networkMode, before.networkMode);
  assert.equal(after.restart, before.restart, 'restart policy preserved');
  assert.equal(after.stopTimeout, before.stopTimeout);
  assert.equal(after.healthcheck.test[1], before.healthcheck.test[1], 'health command preserved');
  assert.equal(ns(after.healthcheck.times), ns(before.healthcheck.times), 'health timings preserved');
  assert.equal(after.logDriver, before.logDriver);
  assert.deepEqual(after.logOpts, before.logOpts, 'log options preserved');
  assert.equal(after.health, 'healthy');
  assert.equal(urlPass(after.env.find((e) => e.startsWith('DATABASE_URL=')).slice(13)), now, 'the running container uses the new password');
  assert.ok(w.state().containers[Object.keys(w.state().containers).find((n) => n.startsWith(`${APP}-pre-rotation-`))], 'the previous container is kept (stopped), not deleted');
  assert.equal(existsSync(join(w.dir, '.rotation-journal')), false, 'the journal is removed on success');
  assert.equal(w.mode(join(w.dir, 'db.env')), '600');
  assert.equal(w.mode(join(w.dir, '.env')), '600');
  // the old password was tried after the rotation and refused
  const logins = w.state().logins;
  assert.equal(logins.at(-1).ok, false, 'the last login check is the superseded password, refused');
  assert.match(r.out, /superseded password\(s\): REJECTED/);
});

test('credential-only: no migration, no image pull or build, no broker, no Audit, no other container touched', () => {
  const w = rotationWorld();
  assert.equal(w.rotate().code, 0);
  const calls = w.state().calls;
  assert.deepEqual(calls.filter((a) => a[0] === 'run' && a.includes('--rm')), [], 'no one-off container (the migration runner) is started');
  assert.ok(!JSON.stringify(calls).includes('migrate'), 'no migration command');
  assert.deepEqual(calls.filter((a) => ['pull', 'build'].includes(a[0])), []);
  assert.equal(w.state().forbidden, undefined);
  assert.ok(!/rabbit|audit|amqp/i.test(JSON.stringify(calls)), 'nothing about RabbitMQ or Audit');
  const touched = new Set(calls.filter((a) => ['run', 'stop', 'rename', 'rm'].includes(a[0])).map((a) => (a.includes('--name') ? a[a.indexOf('--name') + 1] : a.at(-1))));
  for (const n of touched) assert.ok(n.startsWith(APP), `only Auth containers are touched (got ${n})`);
  assert.equal(w.state().containers['nawara-core-auth-db'].running, true, 'the database container is never stopped');
  const sql = w.state().stdin.map((s) => s.text).join('\n');
  assert.match(sql, /SET log_min_error_statement = panic;/, 'the password cannot reach the server log through a failing statement');
  assert.deepEqual([...sql.matchAll(/ALTER ROLE (\w+)/g)].map((m) => m[1]), ['auth_app'], 'only auth_app is altered (never the bootstrap owner)');
});

test('secret-safe: neither the old nor the new password nor DATABASE_URL appears in the output or any docker argv', () => {
  const w = rotationWorld();
  const r = w.rotate();
  assert.equal(r.code, 0);
  const argv = JSON.stringify(w.state().calls);
  for (const s of [w.old, role(w), ...w.secrets()]) {
    assert.ok(!r.out.includes(s), 'a secret was printed');
    assert.ok(!argv.includes(s), 'a secret was passed on a command line');
  }
  assert.doesNotMatch(r.out, /postgres:\/\//, 'DATABASE_URL is never printed');
});

test('URL preservation: host (IPv6), port, database and query options are kept byte for byte', () => {
  const rest = '[fd00::5]:5432/auth?sslmode=disable&application_name=nawara%20auth';
  const w = rotationWorld({ url: `postgres://auth_app:${'0f'.repeat(32)}@${rest}` });
  const r = w.rotate();
  assert.equal(r.code, 0, r.out);
  assert.equal(envVal(read(w, '.env'), 'DATABASE_URL'), `postgres://auth_app:${role(w)}@${rest}`);
});

test('mounts are reproduced exactly (named volume, read-only bind)', () => {
  const mountSpecs = [{ type: 'volume', name: 'auth-cache', dest: '/cache', rw: true }, { type: 'bind', source: '/srv/ca', dest: '/etc/ca', rw: false }];
  const w = rotationWorld({ mountSpecs });
  assert.equal(w.rotate().code, 0);
  assert.deepEqual(w.state().containers[APP].mountSpecs, mountSpecs);
});

test('two rotations produce two different secrets', () => {
  const a = rotationWorld(); const b = rotationWorld();
  assert.equal(a.rotate().code, 0); assert.equal(b.rotate().code, 0);
  assert.notEqual(role(a), role(b));
});

// ---------------------------------------------------------------- preflight: every invariant refuses BEFORE any change
const refusals = [
  ['the Auth container is missing', { noApp: true }, /Auth container nawara-core-auth-service does not exist/],
  ['Auth is unhealthy', { appHealth: 'unhealthy' }, /is not running\/healthy/],
  ['the database container is not running', { dbRunning: false }, /database container nawara-core-auth-db is not running/],
  ['db.env is missing', { dbEnv: null }, /db\.env is missing/],
  ['.env is missing', { appEnv: null }, /\.env is missing/],
  ['AUTH_APP_PASSWORD is missing', { dbEnv: 'POSTGRES_USER=auth\nPOSTGRES_DB=auth\n' }, /AUTH_APP_PASSWORD must occur exactly once/],
  ['DATABASE_URL is missing', { appEnv: 'NODE_ENV=production\nAUTH_EVENTS=off\n' }, /DATABASE_URL must occur exactly once/],
  ['DATABASE_URL connects as another role', { url: `postgres://auth:${'0f'.repeat(32)}@nawara-core-auth-db:5432/auth` }, /does not connect as auth_app/],
  ['auth_app is a superuser', { superuser: true }, /does not exist or is a superuser/],
  ['db.env and .env disagree', { urlPassword: 'e'.repeat(64) }, /PRE-ROTATION CREDENTIAL STATE INCONSISTENT/],
  ['the files agree but PostgreSQL has another password', { rolePassword: 'e'.repeat(64) }, /PRE-ROTATION CREDENTIAL STATE INCONSISTENT: the credential in db\.env\/\.env does not authenticate/],
  ['the running container was started with another environment', { containerEnv: ['NODE_ENV=production', 'EXTRA=1'] }, /environment of nawara-core-auth-service differs/],
  ['PostgreSQL accepts any password over TCP (trust)', { trust: true }, /accepted a random password/],
  ['the container publishes a port or carries unsupported settings', { extras: 'false|||||||ports|||0|0|' }, /carries a setting this script does not reproduce/],
  ['the container has no health check', { healthcheck: null }, /has no shell health check/],
  ['a label spans several lines', { labelCount: 6 }, /spans several lines/],
];
for (const [label, over, reason] of refusals) {
  test(`preflight refuses, changing nothing, when ${label}`, () => {
    const w = rotationWorld(over);
    const was = before(w);
    const r = w.rotate();
    assert.notEqual(r.code, 0);
    assert.match(r.out, reason);
    assert.match(r.out, /nothing was changed/);
    unchanged(w, was);
  });
}

test('preflight refuses a db.env readable by group or others', () => {
  const w = rotationWorld();
  chmodSync(join(w.dir, 'db.env'), 0o640);
  const was = before(w);
  const r = w.rotate();
  assert.match(r.out, /readable by group or others.*nothing was changed/);
  unchanged(w, was);
});

test('a concurrent rotation is refused while another holds the lock', async () => {
  const w = rotationWorld();
  const was = before(w);
  const holder = spawn('flock', ['-x', join(w.dir, '.rotation.lock'), 'sleep', '3']);
  await new Promise((r) => setTimeout(r, 300));
  const r = w.rotate();
  holder.kill();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /another credential rotation is running.*nothing was changed/);
  unchanged(w, was);
});

// ---------------------------------------------------------------- failure recovery: always FORWARD, never back to the exposed password
test('a first attempt that does not verify rolls forward to another fresh password in the same run', () => {
  const w = rotationWorld();
  w.patch((s) => { s.unhealthyRuns = 1; });
  const r = w.rotate();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /rolling forward to another fresh password/);
  const first = w.state().stdin.map((s) => s.text.match(/PASSWORD '([0-9a-f]{64})'/)?.[1]).filter(Boolean)[0];
  assert.notEqual(role(w), first, 'the final password is not the first attempt');
  assert.notEqual(role(w), w.old);
  assert.equal(w.state().logins.slice(-2).every((l) => l.ok === false), true, 'both the exposed and the first-attempt passwords are refused');
});

test('two failed attempts stop with Auth down and the journal kept; the next run resumes FORWARD and finishes', () => {
  const w = rotationWorld();
  w.patch((s) => { s.unhealthyRuns = 2; });
  const r1 = w.rotate();
  assert.notEqual(r1.code, 0);
  assert.match(r1.out, /ROTATION FAILED after a roll-forward retry/);
  assert.ok(existsSync(join(w.dir, '.rotation-journal')));
  assert.equal(w.mode(join(w.dir, '.rotation-journal')), '600');
  const attempted = w.state().stdin.map((s) => s.text.match(/PASSWORD '([0-9a-f]{64})'/)?.[1]).filter(Boolean);
  const r2 = w.rotate();
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /resuming an interrupted rotation: rolling forward/);
  assert.ok(![w.old, ...attempted].includes(role(w)), 'the final password is fresh: neither the exposed one nor an earlier attempt');
  assert.equal(existsSync(join(w.dir, '.rotation-journal')), false);
  assert.equal(w.state().containers[APP].imageId, AUTH_IMAGE_ID);
});

test('interrupted during recreation: journal kept, a normal deploy refuses, the next run resumes and finishes', () => {
  const w = rotationWorld();
  w.patch((s) => { s.failRecreateOnce = true; });
  const r1 = w.rotate();
  assert.notEqual(r1.code, 0);
  assert.match(r1.out, /INTERRUPTED after changes began: the journal .* is kept/);
  const deploy = w.run(SCRIPTS.auth, { IMAGE: 'ghcr.io/nawara-solutions/nawara-core-auth-service:sha-next' });
  assert.notEqual(deploy.code, 0);
  assert.match(deploy.out, /credential rotation was interrupted .*nothing was changed/);
  const r2 = w.rotate();
  assert.equal(r2.code, 0, r2.out);
  assert.equal(envVal(read(w, 'db.env'), 'AUTH_APP_PASSWORD'), role(w));
  assert.equal(urlPass(envVal(read(w, '.env'), 'DATABASE_URL')), role(w));
});

test('interrupted after the journal but before Auth was renamed: the resume stops and renames it, then finishes', () => {
  const w = rotationWorld();
  writeFileSync(join(w.dir, '.rotation-journal'), `OLD=${w.old}\nTARGET=${'9'.repeat(64)}\nSUPERSEDED=\nREF=${APP}-pre-rotation-19700101000000\n`, { mode: 0o600 });
  const r = w.rotate();
  assert.equal(r.code, 0, r.out);
  assert.ok(w.state().containers[`${APP}-pre-rotation-19700101000000`], 'the original container became the reference');
  assert.ok(![w.old, '9'.repeat(64)].includes(role(w)));
});

test('an incomplete journal is refused (never guessed)', () => {
  const w = rotationWorld();
  writeFileSync(join(w.dir, '.rotation-journal'), 'OLD=\n', { mode: 0o600 });
  const r = w.rotate();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /journal .* is incomplete; refusing to guess/);
});

test('SECURITY FAILURE: if a superseded password still authenticates, the rotation is NOT reported successful', () => {
  const w = rotationWorld();
  w.patch((s) => { s.pg.alsoAccept = [w.old]; });
  const r = w.rotate();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /SECURITY FAILURE: a superseded auth_app password still authenticates/);
  assert.doesNotMatch(r.out, /OK {2}auth_app rotated/);
  assert.ok(existsSync(join(w.dir, '.rotation-journal')), 'the journal is kept');
});

// ---------------------------------------------------------------- the tooling trap: the NEXT normal deploy must keep the new password
function withRb2Prerequisites(w) {
  w.patch((s) => {
    s.networks['nawara-core-internal'] = { internal: true };
    s.containers['nawara-core-rabbitmq'] = { id: 'id-broker', image: 'rabbitmq', running: true, health: 'healthy', ports: [], publishAll: false, networks: { 'nawara-core-internal': true }, labels: [], mounts: [] };
    Object.assign(s.broker, AUDIT_TOPOLOGY);
  });
  mkdirSync(join(w.home, 'nawara-core/rabbitmq/clients'), { recursive: true });
  writeFileSync(join(w.home, 'nawara-core/rabbitmq/clients/auth-service.env'), `RABBITMQ_URL=amqp://auth-service:${'5'.repeat(64)}@nawara-core-rabbitmq:5672/nawara-core\n`, { mode: 0o600 });
}

test('FUTURE DEPLOY: after a rotation, the normal Auth deploy re-applies the NEW password and never restores the exposed one', () => {
  const w = rotationWorld();
  assert.equal(w.rotate().code, 0);
  const rotated = role(w);
  withRb2Prerequisites(w);
  const d = w.run(SCRIPTS.auth, { IMAGE: 'ghcr.io/nawara-solutions/nawara-core-auth-service:sha-next' });
  assert.equal(d.code, 0, d.out);
  const applied = w.state().stdin.map((s) => s.text.match(/ALTER ROLE auth_app WITH LOGIN[^']*PASSWORD '([^']*)'/)?.[1]).filter(Boolean);
  assert.equal(applied.at(-1), rotated, 'the deploy re-applied db.env = the rotated password');
  assert.equal(role(w), rotated);
  assert.notEqual(role(w), w.old, 'the exposed password is NOT restored');
  assert.equal(urlPass(envVal(read(w, '.env'), 'DATABASE_URL')), rotated);
  assert.equal(w.state().containers[APP].health, 'healthy', 'the redeployed Auth connects with the rotated password');
});

test('CONTROL: a naive rotation (role + .env only) IS undone by the next deploy, which is why db.env must rotate too', () => {
  const w = rotationWorld();
  const naive = 'a'.repeat(64);
  w.patch((s) => { s.pg.roles.auth_app.password = naive; });
  writeFileSync(join(w.dir, '.env'), read(w, '.env').replace(w.old, naive), { mode: 0o600 });
  withRb2Prerequisites(w);
  w.run(SCRIPTS.auth, { IMAGE: 'ghcr.io/nawara-solutions/nawara-core-auth-service:sha-next' });
  assert.equal(role(w), w.old, 'the deploy re-applied the stale db.env value: the exposed password is valid again');
});

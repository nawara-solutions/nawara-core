// apps/auth-service/deploy/provision-and-deploy.sh against the fake docker CLI: the RB-2 (ADR-0053) additions and the behaviour they
// must preserve. The ORDERING RULE (Auth never relays before the audit queue is bound) is asserted here and in ordering.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_TOPOLOGY, SCRIPTS, assertNothingChanged, provisionedWorld, runOf } from './lib/harness.mjs';

const IMAGE = 'ghcr.io/nawara-solutions/nawara-core-auth-service:sha-test';
const APP = 'nawara-core-auth-service';
const deploy = (w, env = {}) => w.run(SCRIPTS.auth, { IMAGE, ...env });
const auditBound = () => provisionedWorld(['audit-service', 'auth-service'], AUDIT_TOPOLOGY);
const envFile = (w) => readFileSync(join(w.home, 'nawara-core/auth-service/.env'), 'utf8');

test('RABBITMQ_URL stays mandatory: with no source at all the deploy is refused and nothing changes', () => {
  const w = auditBound();
  rmSync(join(w.home, 'nawara-core/rabbitmq/clients/auth-service.env'));
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /RABBITMQ_URL is not set .*nothing was changed/);
  assertNothingChanged(assert, w);
});

test('ORDERING RULE: with the audit queue NOT bound, Auth is refused before anything is migrated, stopped or started', () => {
  const w = provisionedWorld(['audit-service', 'auth-service']); // broker + identities, but audit-service not deployed
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /the audit queue is not bound on nawara-core-rabbitmq .*Deploy audit-service first; nothing was changed/);
  assertNothingChanged(assert, w);
});

test('ORDERING RULE: an unreachable broker is refused the same way (never "assume it is fine")', () => {
  const w = auditBound();
  w.patch((s) => { s.containers['nawara-core-rabbitmq'].running = false; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Deploy audit-service first; nothing was changed/);
  assertNothingChanged(assert, w);
});

test('ORDERING RULE holds even when RABBITMQ_URL is supplied explicitly', () => {
  const w = provisionedWorld(['audit-service', 'auth-service']);
  const r = deploy(w, { RABBITMQ_URL: 'amqp://auth-service:x@nawara-core-rabbitmq:5672/nawara-core' });
  assert.notEqual(r.code, 0);
  assertNothingChanged(assert, w);
});

test('no private Core network -> refused, nothing changed', () => {
  const w = auditBound();
  w.patch((s) => { delete s.networks['nawara-core-internal']; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /docker network 'nawara-core-internal' not found.*nothing was changed/);
  assertNothingChanged(assert, w);
});

test('happy path: broker identity into .env, AUTH_EVENTS=off, joined to the private network, Traefik pinned to deploy_edge, #141 routing kept', () => {
  const w = auditBound();
  const r = deploy(w);
  assert.equal(r.code, 0, r.out);
  const env = envFile(w);
  const client = readFileSync(join(w.home, 'nawara-core/rabbitmq/clients/auth-service.env'), 'utf8').trim();
  assert.ok(env.includes(`${client}\n`), 'RABBITMQ_URL is the broker-provisioned auth-service identity');
  assert.match(env, /^AUTH_EVENTS=off$/m, 'domain events stay off in production (Stage 21.x decides)');
  assert.doesNotMatch(env, /guest/);

  const app = runOf(w, APP);
  assert.deepEqual(app.all('--network'), ['deploy_edge'], 'started on Traefik\'s network');
  assert.deepEqual(w.calls('network', 'connect'), [['network', 'connect', 'nawara-core-internal', APP]], 'and joined to the private Core network');
  const labels = app.all('--label');
  assert.ok(labels.includes('traefik.docker.network=deploy_edge'), 'Traefik must never pick the internal network address');
  assert.ok(labels.includes('traefik.http.routers.nawara-core-auth-service.rule=Host(`core-api.nawara-solutions.com`) && PathPrefix(`/auth`)'));
  // The temporary alias router (its hostname is the script's default and is retired separately): same /auth boundary, same service.
  assert.ok(labels.some((l) => /^traefik\.http\.routers\.nawara-core-auth-service-alias\.rule=Host\(`[^`]+`\) && PathPrefix\(`\/auth`\)$/.test(l)));
  assert.ok(labels.includes('traefik.http.routers.nawara-core-auth-service-alias.service=nawara-core-auth-service'));
  assert.ok(labels.includes('traefik.http.services.nawara-core-auth-service.loadbalancer.server.port=3000'));
});

test('WebAuthn: a new installation gets the Nawara RP and the owner admin UI origin, never the API host', () => {
  const w = auditBound();
  assert.equal(deploy(w, { AUTH_HOST: 'core-api.nawara-solutions.com' }).code, 0);
  const env = envFile(w);
  assert.match(env, /^WEBAUTHN_RP_ID=nawara-solutions\.com$/m);
  assert.match(env, /^WEBAUTHN_ORIGINS=https:\/\/admin\.nawara-solutions\.com$/m);
  assert.match(env, /^WEBAUTHN_RP_NAME=Nawara$/m);
  assert.doesNotMatch(env, /^WEBAUTHN_ORIGINS=.*core-api/m, 'the API host is not a WebAuthn browser origin');
  assert.doesNotMatch(env, /hsalem-anwar/, 'no personal-domain WebAuthn default');
});

test('V2 A2.4: a fresh .env carries no Payment setting (Auth has no Payment client, ADR-0042 Amendment 3), and an existing one is left alone', () => {
  const fresh = auditBound();
  assert.equal(deploy(fresh).code, 0);
  assert.doesNotMatch(envFile(fresh), /^PAYMENT_SERVICE_(TOKEN|URL)=/m, 'the deploy no longer provisions settings Auth does not read');

  // Existing installations are not cleaned up by a deploy (removing an entry from a server .env is a separate, deliberate action).
  const existing = auditBound();
  mkdirSync(join(existing.home, 'nawara-core/auth-service'), { recursive: true });
  writeFileSync(join(existing.home, 'nawara-core/auth-service/.env'), 'PAYMENT_SERVICE_URL=http://kept.invalid\n');
  assert.equal(deploy(existing).code, 0);
  assert.match(envFile(existing), /^PAYMENT_SERVICE_URL=http:\/\/kept\.invalid$/m, 'an entry already on the server is neither removed nor rewritten');
  assert.doesNotMatch(envFile(existing), /^PAYMENT_SERVICE_TOKEN=/m);
});

test('WebAuthn: existing values in .env are never overwritten by a deployment (changing them is a deliberate edit)', () => {
  const w = auditBound();
  mkdirSync(join(w.home, 'nawara-core/auth-service'), { recursive: true });
  writeFileSync(join(w.home, 'nawara-core/auth-service/.env'), 'WEBAUTHN_RP_ID=hsalem-anwar.dev\nWEBAUTHN_ORIGINS=https://core-api.hsalem-anwar.dev\n');
  assert.equal(deploy(w).code, 0);
  const env = envFile(w);
  assert.deepEqual(env.split('\n').filter((l) => l.startsWith('WEBAUTHN_RP_ID=') || l.startsWith('WEBAUTHN_ORIGINS=')),
    ['WEBAUTHN_RP_ID=hsalem-anwar.dev', 'WEBAUTHN_ORIGINS=https://core-api.hsalem-anwar.dev']);
});

test('an existing RABBITMQ_URL in .env is never overwritten by the broker identity', () => {
  const w = auditBound();
  mkdirSync(join(w.home, 'nawara-core/auth-service'), { recursive: true });
  writeFileSync(join(w.home, 'nawara-core/auth-service/.env'), 'RABBITMQ_URL=amqp://operator-set@nawara-core-rabbitmq:5672/nawara-core\n');
  assert.equal(deploy(w).code, 0);
  assert.deepEqual(envFile(w).split('\n').filter((l) => l.startsWith('RABBITMQ_URL=')), ['RABBITMQ_URL=amqp://operator-set@nawara-core-rabbitmq:5672/nawara-core']);
});

test('if joining the private network fails, the new container is removed and the previous one restored', () => {
  const w = auditBound();
  assert.equal(deploy(w).code, 0);
  const firstId = w.state().containers[APP].id;
  w.patch((s) => { s.failConnect = true; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not attached to nawara-core-internal/);
  assert.match(r.out, /rolling back to nawara-core-auth-service-previous-/);
  assert.equal(w.state().containers[APP].id, firstId);
  assert.equal(w.state().containers[APP].running, true);
});

test('secret-safe: no generated secret (database, JWT, peppers, broker) in the output or in any docker argv', () => {
  const w = auditBound();
  const r = deploy(w);
  assert.equal(r.code, 0);
  const argv = JSON.stringify(w.state().calls);
  const secrets = w.secrets();
  assert.ok(secrets.length >= 8);
  for (const s of secrets) {
    assert.ok(!r.out.includes(s), 'a secret was printed');
    assert.ok(!argv.includes(s), 'a secret was passed on a command line');
  }
});

// V2-A.2: the manual deployment passes an exact INDEX digest reference (IMAGE_NAME@sha256:…), never a tag. The script must use exactly
// that reference for the migrations and for the new container, and keep its ordering: migrations first, the running service untouched
// until they succeed, the previous container retained.
const DIGEST_IMAGE = `ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:${'ab12'.repeat(16)}`;

test('digest deployment: migrations and the new container use exactly IMAGE_NAME@digest; migrations run before the swap', () => {
  const w = auditBound();
  assert.equal(deploy(w).code, 0);
  const before = w.state().calls.length;
  const r = deploy(w, { IMAGE: DIGEST_IMAGE });
  assert.equal(r.code, 0, r.out);
  const calls = w.state().calls.slice(before);
  const runs = calls.filter((a) => a[0] === 'run');
  const images = runs.map((a) => a.find((x) => x.includes('nawara-core-auth-service@') || x.includes('nawara-core-auth-service:'))).filter(Boolean);
  assert.deepEqual([...new Set(images)], [DIGEST_IMAGE], 'no tag and no other image is ever run');
  const migrateAt = calls.findIndex((a) => a[0] === 'run' && a.includes('dist/cli/migrate.js'));
  const stopAt = calls.findIndex((a) => a[0] === 'stop' && a.includes(APP));
  assert.ok(migrateAt >= 0 && stopAt > migrateAt, 'migrations run before the running service is stopped');
  assert.equal(runOf(w, APP).image, DIGEST_IMAGE);
  assert.ok(Object.keys(w.state().containers).some((n) => n.startsWith(`${APP}-previous-`)), 'the previous container is retained');
});

test('digest deployment: a failed migration stops the deploy before the running service is touched', () => {
  const w = auditBound();
  assert.equal(deploy(w).code, 0);
  const running = w.state().containers[APP].id;
  w.patch((s) => { s.failRm = { ...(s.failRm ?? {}), [DIGEST_IMAGE]: true }; });
  const before = w.state().calls.length;
  const r = deploy(w, { IMAGE: DIGEST_IMAGE });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /migrations failed or were refused; the running service was not touched/);
  const after = w.state().calls.slice(before);
  // (the database container may be started: it is ensured before the migrations; the application is never touched)
  assert.deepEqual(after.filter((a) => (['stop', 'rename', 'start'].includes(a[0]) && a.includes(APP)) || (a[0] === 'run' && a.includes('-d'))), [],
    'the application container is not stopped, renamed, replaced or started');
  assert.equal(w.state().containers[APP].id, running);
  assert.equal(w.state().containers[APP].running, true);
});

// ---------------------------------------------------------------- V2 A4.8: JWT key provisioning (D6) and the configuration check
// ADR-0058 / A4 record §10.8 and §11. The script generates JWT_SECRET only for a configuration with no JWT key of any form, never repairs
// one, and has the image's own loader (dist/cli/check-config.js) validate the effective .env before any migration or container change.
const authDir = (w) => join(w.home, 'nawara-core/auth-service');
const seedEnv = (w, text) => { mkdirSync(authDir(w), { recursive: true }); writeFileSync(join(authDir(w), '.env'), text, { mode: 0o600 }); };
const linesOf = (w, name) => envFile(w).split('\n').filter((l) => l.startsWith(`${name}=`));
const key = (c) => Buffer.alloc(32, c).toString('base64');
const JWT_NAMES = ['JWT_SECRET', 'JWT_SECRET_FILE', 'JWT_SIGNING_KEYS', 'JWT_SIGNING_KEYS_FILE', 'JWT_ACTIVE_KEY_ID', 'JWT_ACTIVE_KEY_ID_FILE'];
const jwtLines = (w) => envFile(w).split('\n').filter((l) => JWT_NAMES.some((n) => l.startsWith(`${n}=`)));

test('A4.8 fresh legacy installation: one generated JWT_SECRET (base64 of 32 bytes) and no ring variable', () => {
  const w = auditBound();
  const r = deploy(w);
  assert.equal(r.code, 0, r.out);
  const secret = linesOf(w, 'JWT_SECRET');
  assert.equal(secret.length, 1);
  assert.equal(Buffer.from(secret[0].slice('JWT_SECRET='.length), 'base64').length, 32);
  assert.deepEqual(jwtLines(w), secret, 'no ring variable is ever written by the deploy');
  assert.match(r.out, /\+ JWT_SECRET \(new\)/);
});

test('A4.8 existing legacy installation: JWT_SECRET is kept byte for byte across deploys', () => {
  const w = auditBound();
  seedEnv(w, `JWT_SECRET=${key(1)}\n`);
  assert.equal(deploy(w).code, 0);
  assert.equal(deploy(w).code, 0);
  assert.deepEqual(jwtLines(w), [`JWT_SECRET=${key(1)}`]);
});

test('A4.8 ring configured with legacy active: the three JWT lines are left exactly as they are', () => {
  const w = auditBound();
  const lines = [`JWT_SECRET=${key(1)}`, `JWT_SIGNING_KEYS=k2026-10:${key(2)}`, 'JWT_ACTIVE_KEY_ID=legacy'];
  seedEnv(w, `${lines.join('\n')}\n`);
  assert.equal(deploy(w).code, 0);
  assert.deepEqual(jwtLines(w), lines);
});

test('A4.8 D6: a ring key active with JWT_SECRET retired is never given a regenerated JWT_SECRET', () => {
  const w = auditBound();
  const lines = [`JWT_SIGNING_KEYS=k2026-10:${key(2)}`, 'JWT_ACTIVE_KEY_ID=k2026-10'];
  seedEnv(w, `${lines.join('\n')}\n`);
  const r = deploy(w);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(jwtLines(w), lines, 'the retired legacy key stays retired');
  assert.doesNotMatch(r.out, /\+ JWT_SECRET \(new\)/);
});

test('A4.8 JWT_SECRET_FILE only: no JWT_SECRET is added next to it (NAME + NAME_FILE would be refused at startup)', () => {
  const w = auditBound();
  seedEnv(w, 'JWT_SECRET_FILE=/run/secrets/jwt\n');
  assert.equal(deploy(w).code, 0);
  assert.deepEqual(jwtLines(w), ['JWT_SECRET_FILE=/run/secrets/jwt']);
});

for (const name of JWT_NAMES.filter((n) => n !== 'JWT_SECRET' && n !== 'JWT_SECRET_FILE')) {
  test(`A4.8 incomplete ring (only ${name}): never repaired, no JWT_SECRET generated; the image's check refuses it before anything changes`, () => {
    const w = auditBound();
    assert.equal(deploy(w).code, 0); // a running installation
    const running = w.state().containers[APP].id;
    const line = `${name}=${name.startsWith('JWT_SIGNING_KEYS') && !name.endsWith('_FILE') ? `k1:${key(3)}` : name.endsWith('_FILE') ? '/run/secrets/x' : 'k1'}`;
    writeFileSync(join(authDir(w), '.env'), envFile(w).split('\n').filter((l) => !l.startsWith('JWT_SECRET=')).concat(line).join('\n') + '\n', { mode: 0o600 });
    w.patch((s) => { s.configCheck = { exit: 1, output: 'configuration invalid: JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together' }; });
    const before = w.state().calls.length;
    const r = deploy(w, { IMAGE: DIGEST_IMAGE });
    assert.notEqual(r.code, 0);
    assert.deepEqual(jwtLines(w), [line], 'the shell decides only whether to generate; it never repairs a JWT configuration');
    assert.match(r.out, /configuration invalid: JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together/);
    assert.match(r.out, /refused by the image's configuration check; no migration ran and the running service was not touched/);
    const after = w.state().calls.slice(before);
    assert.equal(after.filter((a) => a[0] === 'run' && a.includes('dist/cli/migrate.js')).length, 0, 'no migration ran');
    assert.deepEqual(after.filter((a) => (['stop', 'rename', 'start', 'rm'].includes(a[0]) && a.includes(APP)) || (a[0] === 'run' && a.includes('-d'))), []);
    assert.equal(after.filter((a) => a[0] === 'exec' && a.includes('psql')).length, 0, 'the runtime role was not touched');
    assert.equal(w.state().containers[APP].id, running);
    assert.equal(w.state().containers[APP].running, true);
  });
}

test('A4.8 the configuration check runs the exact image, offline, on the effective .env, before the migrations and the swap', () => {
  const w = auditBound();
  assert.equal(deploy(w).code, 0);
  const before = w.state().calls.length;
  const checksBefore = (w.state().configChecks ?? []).length;
  const r = deploy(w, { IMAGE: DIGEST_IMAGE });
  assert.equal(r.code, 0, r.out);
  const calls = w.state().calls.slice(before);
  const checkAt = calls.findIndex((a) => a[0] === 'run' && a.includes('dist/cli/check-config.js'));
  const migrateAt = calls.findIndex((a) => a[0] === 'run' && a.includes('dist/cli/migrate.js'));
  const roleAt = calls.findIndex((a) => a[0] === 'exec' && a.includes('psql'));
  const stopAt = calls.findIndex((a) => a[0] === 'stop' && a.includes(APP));
  assert.ok(checkAt >= 0, 'the configuration check ran');
  assert.ok(checkAt < migrateAt && checkAt < roleAt && checkAt < stopAt, 'validation precedes the migrations, the role and the stop');
  const argv = calls[checkAt];
  assert.deepEqual(argv.slice(0, 2), ['run', '--rm']);
  assert.equal(argv[argv.indexOf('--network') + 1], 'none', 'no network: no database, broker or production connection');
  assert.equal(argv[argv.indexOf('--env-file') + 1], join(authDir(w), '.env'));
  assert.equal(argv[argv.indexOf('--entrypoint') + 1], 'node');
  assert.deepEqual(argv.slice(-2), [DIGEST_IMAGE, 'dist/cli/check-config.js'], 'the image being deployed checks its own configuration');
  const check = w.state().configChecks.slice(checksBefore)[0];
  for (const n of ['NODE_ENV', 'DATABASE_URL', 'JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'TOTP_ENCRYPTION_KEYS', 'RABBITMQ_URL', 'WEBAUTHN_RP_ID', 'AUTH_EVENTS']) {
    assert.ok(check.names.includes(n), `the check saw the complete .env (${n})`);
  }
  assert.match(r.out, /configuration valid; JWT: legacy only/);
});

test('A4.8 a fresh installation is checked too, after its .env is written and before its first migration', () => {
  const w = auditBound();
  const r = deploy(w);
  assert.equal(r.code, 0, r.out);
  const calls = w.state().calls;
  const checkAt = calls.findIndex((a) => a[0] === 'run' && a.includes('dist/cli/check-config.js'));
  const migrateAt = calls.findIndex((a) => a[0] === 'run' && a.includes('dist/cli/migrate.js'));
  assert.ok(checkAt >= 0 && checkAt < migrateAt);
  assert.ok(w.state().configChecks[0].names.includes('JWT_SECRET'));
});

test('A4.8 secret-safe on refusal: no key in the output or in any docker argv, and the check never receives a value on its command line', () => {
  const w = auditBound();
  seedEnv(w, `JWT_SECRET=${key(1)}\nJWT_SIGNING_KEYS=k2026-10:${key(2)}\nJWT_ACTIVE_KEY_ID=k2026-10\n`);
  w.patch((s) => { s.configCheck = { exit: 1, output: 'configuration invalid: JWT_SIGNING_KEYS must differ from JWT_SECRET (one key, one purpose)' }; });
  const r = deploy(w);
  assert.notEqual(r.code, 0);
  const argv = JSON.stringify(w.state().calls);
  for (const s of [key(1), key(2), ...w.secrets()]) {
    assert.ok(!r.out.includes(s), 'a secret was printed');
    assert.ok(!argv.includes(s), 'a secret was passed on a command line');
  }
});

// V2 A4.8 (review F3): Docker's --env-file decides what a JWT line means, so the deploy accepts only one plain `NAME=value` line at the
// start of a line per JWT variable. Anything else is refused before anything changes, never normalized, and never printed.
const MALFORMED = [
  ['leading whitespace', `  JWT_SECRET=${key(1)}`],
  ['a leading tab', `\tJWT_SIGNING_KEYS=k1:${key(2)}`],
  ['an export prefix', `export JWT_SECRET=${key(1)}`],
  ['a space before =', `JWT_ACTIVE_KEY_ID =k1`],
  ['a bare name (Docker would take it from the deploy shell)', 'JWT_SECRET'],
  ['a bare _FILE name with trailing spaces', 'JWT_SIGNING_KEYS_FILE   '],
];
for (const [label, line] of MALFORMED) {
  test(`A4.8 F3: a malformed JWT declaration (${label}) is refused before anything changes, the .env untouched, no value printed`, () => {
    const w = auditBound();
    const text = `NODE_ENV=production\n${line}\nJWT_ISSUER=nawara-auth\n`;
    seedEnv(w, text);
    const r = deploy(w);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /malformed JWT declaration on line\(s\) 2: each JWT variable must be one NAME=value line .*nothing was changed/);
    assert.equal(envFile(w), text, 'never normalized or repaired');
    assertNothingChanged(assert, w);
    assert.ok(!r.out.includes(key(1)) && !r.out.includes(key(2)), 'no value printed');
  });
}

for (const name of JWT_NAMES) {
  test(`A4.8 F3: ${name} declared twice is refused (only one would take effect), the .env untouched`, () => {
    const w = auditBound();
    const v = name.endsWith('_FILE') ? '/run/secrets/x' : name === 'JWT_ACTIVE_KEY_ID' ? 'k1' : name === 'JWT_SECRET' ? key(1) : `k1:${key(2)}`;
    const text = `${name}=${v}\nAUTH_EVENTS=off\n${name}=${v.replace(/k1/, 'k2')}\n`;
    seedEnv(w, text);
    const r = deploy(w);
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp(`declares ${name} more than once: keep exactly one line per JWT variable .*nothing was changed`));
    assert.equal(envFile(w), text);
    assertNothingChanged(assert, w);
    assert.ok(!r.out.includes(key(1)) && !r.out.includes(key(2)));
  });
}

test('A4.8 F3: comments, other JWT_* settings and similar names are not JWT key declarations and pass', () => {
  const w = auditBound();
  seedEnv(w, `# JWT_SECRET=old (comment)\n  # JWT_SIGNING_KEYS=x\nJWT_ISSUER=nawara-auth\nJWT_AUDIENCE=nawara\nJWT_SECRET_NOTES=x\nJWT_SECRET=${key(1)}\n`);
  const r = deploy(w);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(jwtLines(w), [`JWT_SECRET=${key(1)}`]);
});

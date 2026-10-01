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

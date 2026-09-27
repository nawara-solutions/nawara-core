// infra/rabbitmq/provision.sh against the fake docker CLI (ADR-0053). The real-broker proof is scripts/deploy-tests/real-broker.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SCRIPTS, assertNothingChanged, runOf, world } from './lib/harness.mjs';

const BROKER = 'nawara-core-rabbitmq';

test('a fresh run creates ONE private broker: internal network, no published port, named volume, fixed hostname, real health check', () => {
  const w = world();
  const r = w.run(SCRIPTS.broker);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(w.calls('network', 'create'), [['network', 'create', '--internal', 'nawara-core-internal']]);
  const run = runOf(w, BROKER);
  assert.ok(run, 'the broker container is created');
  for (const f of ['-p', '--publish', '-P', '--publish-all']) assert.deepEqual(run.all(f), [], `no ${f}`);
  assert.deepEqual(run.all('--network'), ['nawara-core-internal'], 'attached to the internal network only (never deploy_edge)');
  assert.deepEqual(run.all('-v'), ['nawara-core-rabbitmq-data:/var/lib/rabbitmq'], 'the data directory is on a named volume');
  assert.deepEqual(run.all('--hostname'), [BROKER], 'the node name (and so its data directory) survives recreation');
  assert.deepEqual(run.all('--restart'), ['unless-stopped']);
  assert.ok(run.all('--label').includes('traefik.enable=false'), 'never routed by Traefik');
  const health = run.all('--health-cmd')[0];
  assert.match(health, /su-exec rabbitmq rabbitmq-diagnostics -q check_running/);
  assert.match(health, /check_port_connectivity/, 'health = the AMQP listener is up, not "the container runs"');
  assert.match(run.image, /^rabbitmq:3\.13\.7-alpine@sha256:[0-9a-f]{64}$/, 'an immutable, pinned image (no management UI, never latest)');
  assert.equal(w.state().rootCli, undefined, 'every broker CLI call runs as the rabbitmq user');
});

test('identities: one per service, non-guest administrator, least-privilege grants, passwords never on a command line', () => {
  const w = world();
  assert.equal(w.run(SCRIPTS.broker).code, 0);
  const env = readFileSync(join(w.home, 'nawara-core/rabbitmq/rabbitmq.env'), 'utf8');
  assert.match(env, /^RABBITMQ_DEFAULT_USER=nawara-admin$/m, 'a non-guest default user, so the broker never creates guest');
  assert.match(env, /^RABBITMQ_DEFAULT_PASS=[0-9a-f]{64}$/m);
  const b = w.state().broker;
  assert.deepEqual(Object.keys(b.users).sort(), ['audit-service', 'auth-service']);
  assert.equal(b.passwordOnArgv, undefined, 'passwords travel on stdin only');
  for (const u of ['audit-service', 'auth-service']) assert.deepEqual(b.users[u].tags, [], `${u} has no management tag`);
  assert.deepEqual(b.perms['auth-service'], { vhost: 'nawara-core', conf: '^nawara\\.events$', write: '^nawara\\.events$', read: '^$' });
  assert.deepEqual(b.topic['auth-service'], { exchange: 'nawara.events', write: '^audit\\.', read: '^$' }, 'Auth publishes audit.* only');
  assert.deepEqual(b.topic['audit-service'], { exchange: 'nawara.events', write: '^$', read: '^audit\\.' }, 'Audit binds audit.* only, publishes nothing to the exchange');
  // Evaluated as RabbitMQ does: each grant is a regex over resource names.
  const may = (svc, kind, resource) => new RegExp(b.perms[svc][kind === 'configure' ? 'conf' : kind]).test(resource);
  assert.equal(may('audit-service', 'write', 'nawara.events'), false, 'Audit may not publish to the event exchange');
  assert.equal(may('audit-service', 'write', 'amq.default'), true, 'retry / dead-letter copies go through the default exchange');
  assert.equal(may('audit-service', 'configure', 'notification.events'), false, 'Audit may not declare another service queue');
  assert.equal(may('audit-service', 'read', 'audit-service.audit'), true);
  assert.equal(may('auth-service', 'read', 'audit-service.audit'), false, 'Auth consumes nothing');
  assert.equal(may('auth-service', 'configure', 'audit-service.audit'), false, 'Auth declares no queue');
  assert.equal(may('auth-service', 'write', 'amq.default'), false);
  for (const s of ['audit-service', 'auth-service']) {
    const f = join(w.home, `nawara-core/rabbitmq/clients/${s}.env`);
    assert.match(readFileSync(f, 'utf8'), new RegExp(`^RABBITMQ_URL=amqp://${s}:[0-9a-f]{64}@${BROKER}:5672/nawara-core\\n$`));
    assert.equal(w.mode(f), '600');
    assert.equal(b.users[s].password, readFileSync(f, 'utf8').match(/:([0-9a-f]{64})@/)[1], 'the broker holds the stored password');
  }
  assert.equal(w.mode(join(w.home, 'nawara-core/rabbitmq')), '700');
  assert.equal(w.mode(join(w.home, 'nawara-core/rabbitmq/clients')), '700');
});

test('secret-safe: no generated secret appears in the output or in any docker argv', () => {
  const w = world();
  const r = w.run(SCRIPTS.broker);
  assert.equal(r.code, 0);
  const argv = JSON.stringify(w.state().calls);
  const secrets = w.secrets();
  assert.ok(secrets.length >= 3);
  for (const s of secrets) {
    assert.ok(!r.out.includes(s), 'a secret was printed');
    assert.ok(!argv.includes(s), 'a secret was passed on a command line');
  }
});

test('idempotent: a re-run creates nothing, rotates nothing and reuses the stored identities', () => {
  const w = world();
  assert.equal(w.run(SCRIPTS.broker).code, 0);
  const before = w.secrets().sort();
  const runs = w.calls('run').length;
  const r = w.run(SCRIPTS.broker);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /\(new\)|creating/);
  assert.equal(w.calls('run').length, runs, 'the broker is never recreated by a re-run');
  assert.deepEqual(w.secrets().sort(), before);
});

test('an unknown service is refused before anything changes (Billing / Payment grants are not defined yet)', () => {
  const w = world();
  const r = w.run(SCRIPTS.broker, { RABBITMQ_SERVICES: 'audit-service payment-service' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no broker identity is defined for 'payment-service'.*nothing was changed/);
  assertNothingChanged(assert, w);
});

test('an existing network that is not --internal is refused (the broker is never placed on a routable network)', () => {
  const w = world({ networks: { deploy_edge: { internal: false }, 'nawara-core-internal': { internal: false } } });
  const r = w.run(SCRIPTS.broker);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /is not --internal.*nothing was changed/);
  assertNothingChanged(assert, w);
});

test('an existing broker that publishes a port is refused', () => {
  const w = world();
  assert.equal(w.run(SCRIPTS.broker).code, 0);
  w.patch((s) => { s.containers[BROKER].ports = ['0.0.0.0:5672:5672']; });
  const r = w.run(SCRIPTS.broker);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /publishes a host port/);
});

test('an existing broker attached to another network as well (e.g. deploy_edge) is refused', () => {
  const w = world();
  assert.equal(w.run(SCRIPTS.broker).code, 0);
  w.patch((s) => { s.containers[BROKER].networks.deploy_edge = true; });
  assert.match(w.run(SCRIPTS.broker).out, /must be attached to nawara-core-internal only/);
});

test('a broker that never becomes ready fails the run before any identity is created', () => {
  const w = world({ broker: { ready: false } });
  const r = w.run(SCRIPTS.broker);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /is not ready/);
  assert.deepEqual(w.state().broker.users, {});
});

test('a broker user whose client file was lost is not silently reset', () => {
  const w = world();
  assert.equal(w.run(SCRIPTS.broker).code, 0);
  rmSync(join(w.home, 'nawara-core/rabbitmq/clients/auth-service.env'));
  const r = w.run(SCRIPTS.broker);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /broker user auth-service exists but .* is missing; refusing to guess or reset its password/);
});

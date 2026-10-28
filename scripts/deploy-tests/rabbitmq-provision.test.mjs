// infra/rabbitmq/provision.sh against the fake docker CLI (ADR-0053). The real-broker proof is scripts/deploy-tests/real-broker.mjs.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SCRIPTS, assertNothingChanged, runOf, world } from './lib/harness.mjs';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTIVATION_FILE, DENY_ALL, generateTopicPermissions } from '../lib/topic-permissions.mjs';

// Core V2 S1d-2: the grants the script must apply are the generator's, from the repository's own sources and reviewed activation file.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APPS = readdirSync(join(ROOT, 'apps'));
const GENERATED = generateTopicPermissions({
  apps: APPS,
  contracts: Object.fromEntries(APPS.filter((a) => existsSync(join(ROOT, 'apps', a, 'contracts/events.json'))).map((a) => [a, readFileSync(join(ROOT, 'apps', a, 'contracts/events.json'), 'utf8')])),
  auditCatalog: readFileSync(join(ROOT, 'libs/audit-contract/src/catalog.ts'), 'utf8'),
  activation: JSON.parse(readFileSync(join(ROOT, ACTIVATION_FILE), 'utf8')),
}).identities;
const topicOf = (svc) => ({ exchange: 'nawara.events', write: GENERATED[svc].write.regex, read: GENERATED[svc].read.regex });
const ALL = ['audit-service', 'auth-service', 'billing-service', 'file-service', 'notification-service', 'organization-service', 'payment-service', 'release-service'];

const BROKER = 'nawara-core-rabbitmq';
const GATED_FREE = ALL.filter((s) => s !== 'notification-service');

/** A role function of the script, evaluated by bash itself on a queue name: what `permissions_for` would apply. */
const roleOf = (fn, queue) => {
  const out = execFileSync('bash', ['-c', `EXCHANGE=nawara.events; eval "$(sed -n '/^${fn}() {/,/^}/p' ${JSON.stringify(SCRIPTS.broker)})"; ${fn} ${queue}; printf '%s\\n%s\\n%s' "$PERM_CONF" "$PERM_WRITE" "$PERM_READ"`], { encoding: 'utf8' });
  const [conf, write, read] = out.split('\n');
  return { conf, write, read };
};

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
  // Core V2 S1d-2: Auth publishes exactly its own audit actions (its domain events are inactive); Audit binds exactly `audit.#` and
  // publishes nothing (deny-all, not '^$', which would match the empty routing key).
  assert.deepEqual(b.topic['auth-service'], topicOf('auth-service'), 'Auth: its generated grants');
  // 28 + the three authorization receipt actions (Core V2 S2-Audit.2, D1)
  assert.equal(GENERATED['auth-service'].write.keys.length, 31);
  assert.ok(GENERATED['auth-service'].write.keys.every((k) => k.startsWith('audit.')), 'no Auth domain event while inactive');
  assert.equal(b.topic['auth-service'].read, DENY_ALL);
  assert.deepEqual(b.topic['audit-service'], { exchange: 'nawara.events', write: DENY_ALL, read: '^(audit\\.#)$' }, 'Audit binds audit.# only, publishes nothing to the exchange');
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

test('an unknown service is refused before anything changes', () => {
  const w = world();
  const r = w.run(SCRIPTS.broker, { RABBITMQ_SERVICES: 'audit-service ghost-service' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no broker identity is defined for 'ghost-service'.*nothing was changed/);
  assertNothingChanged(assert, w);
});

test('S1d-2: the default selection is unchanged; Billing and Payment are defined but never provisioned unless selected', () => {
  const w = world();
  assert.equal(w.run(SCRIPTS.broker).code, 0);
  assert.deepEqual(Object.keys(w.state().broker.users).sort(), ['audit-service', 'auth-service']);
  assert.deepEqual(Object.keys(w.state().broker.topic).sort(), ['audit-service', 'auth-service']);
});

test('S1d-2: every identity, when selected, gets exactly its generated topic grants and its role\'s resource permissions', () => {
  const w = world();
  // Core V2 OD-BRK-2a: notification-service is granted only behind its topology gate (its own tests below), so it is not selected here
  const r = w.run(SCRIPTS.broker, { RABBITMQ_SERVICES: GATED_FREE.join(' ') });
  assert.equal(r.code, 0, r.out);
  const b = w.state().broker;
  assert.deepEqual(Object.keys(b.users).sort(), GATED_FREE);
  for (const svc of GATED_FREE) assert.deepEqual(b.topic[svc], topicOf(svc), `${svc}: generated topic grants`);
  const counts = Object.fromEntries(ALL.map((s) => [s, [GENERATED[s].write.keys.length, GENERATED[s].read.keys.length]]));
  // auth-service: 28 + the three authorization receipt actions (Core V2 S2-Audit.2, D1); file-service: 2 + the two evidence-grant actions (S2-File.1) + file.granted_read (S2-File.2) + the two hold actions (S2-File.3); billing-service: 12 + the three assistance-request actions (S5a, D-9) + the three settlement / cash-return actions (S5b, E-13) + the five confirmation / dispute / correction actions (S5c)
  assert.deepEqual(counts, { 'audit-service': [0, 1], 'auth-service': [31, 0], 'billing-service': [23, 4], 'file-service': [7, 0], 'notification-service': [0, 9], 'organization-service': [7, 0], 'payment-service': [10, 0], 'release-service': [4, 0] });
  // RabbitMQ evaluates a topic grant as a regex over the routing key (write) or binding key (read)
  const pub = (svc, key) => new RegExp(b.topic[svc].write).test(key);
  const bind = (svc, key) => new RegExp(b.topic[svc].read).test(key);
  assert.ok(pub('payment-service', 'payment.created') && pub('payment-service', 'audit.payment.succeeded'));
  assert.ok(!pub('payment-service', 'audit.payment.event_reemitted') && !pub('payment-service', 'invoice.created') && !pub('payment-service', 'payment.refunded'));
  assert.equal(b.topic['payment-service'].read, DENY_ALL, 'Payment binds nothing');
  assert.ok(pub('billing-service', 'invoice.created') && pub('billing-service', 'audit.invoice.issued') && !pub('billing-service', 'payment.succeeded'));
  for (const k of ['payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired']) assert.ok(bind('billing-service', k), k);
  assert.ok(!bind('billing-service', 'payment.created') && !bind('billing-service', 'payment.#') && !bind('billing-service', 'audit.#'));
  assert.ok(!pub('auth-service', 'membership.approved') && !pub('auth-service', 'audit.payment.created') && !pub('organization-service', 'audit.owner.factor_enrolled'));
  assert.ok(!pub('audit-service', 'audit.platform_query.executed'), 'Audit records its own action locally: no grant');
  const notif = new RegExp(GENERATED['notification-service'].read.regex);
  assert.ok(notif.test('member.contact_verification_requested') && !notif.test('audit.#'));
  for (const svc of GATED_FREE) for (const k of ['', '#', 'audit.#.x', 'x']) assert.ok(!pub(svc, k), `${svc} may publish ${JSON.stringify(k)}`);
  // resource permissions: unchanged roles; Billing is the union of a producer and a consumer of billing.payment-events
  const may = (svc, kind, resource) => new RegExp(b.perms[svc][kind === 'configure' ? 'conf' : kind]).test(resource);
  assert.deepEqual(b.perms['payment-service'], b.perms['auth-service'], 'Payment: the producer role');
  assert.ok(may('billing-service', 'write', 'nawara.events') && may('billing-service', 'write', 'amq.default') && may('billing-service', 'read', 'billing.payment-events'));
  for (const q of ['billing.payment-events', 'billing.payment-events.retry', 'billing.payment-events.dead', 'nawara.events.dlx']) assert.ok(may('billing-service', 'configure', q), q);
  for (const foreign of ['audit-service.audit', 'notification.events', 'audit-service.audit.dead']) {
    assert.ok(!may('billing-service', 'read', foreign) && !may('billing-service', 'configure', foreign), `Billing may not touch ${foreign}`);
  }
  assert.ok(!may('payment-service', 'write', 'amq.default') && !may('payment-service', 'read', 'billing.payment-events'));
  assert.ok(r.out.includes("topic nawara.events write ^(?!)$ read ^(audit\\.#)$"), 'the applied grants are logged (names and patterns only)');
});

test('OD-BRK-2a: notification-service is never granted without a passing topology gate: no latch / no verifiable broker -> refused, no grant', () => {
  const w = world();
  const r = w.run(SCRIPTS.broker, { RABBITMQ_SERVICES: 'audit-service notification-service' });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /notification-service NOT provisioned: the pre-grant topology verification did not pass/);
  assert.match(r.out, /"result":"(UNKNOWN|FAIL)"/);
  assert.doesNotMatch(r.out, /"result":"PASS"/);
  const b = w.state().broker;
  assert.ok(b.users['audit-service'], 'the other identity of the run is still converged');
  assert.equal(b.users['notification-service'], undefined, 'no notification-service user');
  assert.equal(b.perms['notification-service'], undefined, 'no grant');
  assert.equal(b.topic['notification-service'], undefined, 'no topic grant');
});

test('OD-BRK-2a: the isolated consumer role is the consumer role minus the shared dead-letter exchange (read from the script itself)', () => {
  const iso = roleOf('isolated_consumer', 'notification.events');
  const legacy = roleOf('consumer', 'notification.events');
  for (const k of ['conf', 'write', 'read']) {
    assert.doesNotMatch(iso[k], /dlx/, k);
    assert.equal(iso[k], legacy[k].replace('|nawara\\.events\\.dlx', ''), k);
  }
  assert.equal(iso.conf, '^(nawara\\.events|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$');
  assert.equal(iso.write, '^(amq\\.default|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$');
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

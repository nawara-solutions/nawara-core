// Real-broker certification of the production RabbitMQ provisioning (ADR-0053), against a LOCAL Docker daemon only:
//   npm run test:deploy:real-broker            (needs Docker on Linux and a built @nawara/service-kit)
//
// Provisions an isolated broker with infra/rabbitmq/provision.sh (container, network, volume and state dir all prefixed `rbreal-`),
// then drives it with the REAL service-kit bus under each service identity, so the permission regexes are proven against exactly the
// AMQP operations the services perform, and nothing more. Everything it creates is removed at the end.
// Core V2 OD-BRK-2a: Notification is provisioned only through its real topology gate, so the run supplies a TEST-ONLY, root-owned latch
// (inactive) in its own directory (lib/test-latch.mjs), and Notification subscribes with its approved isolated topology.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LATCH_STATE, latchPath, removeTestLatch, writeTestLatch } from './lib/test-latch.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const { RabbitMqEventBus, noBrokerDeadLettering } = require(join(root, 'libs/service-kit/dist/index.js'));
const amqp = require('amqplib');

const run = `rbreal-${process.pid}`;
const latchDir = mkdtempSync(join(tmpdir(), `${run}-latch-`)); // holds only the root-owned test latch
const env = {
  ...process.env,
  BROKER_DIR: mkdtempSync(join(tmpdir(), 'rbreal-')),
  CORE_NETWORK: `${run}-internal`,
  RABBITMQ_CONTAINER: `${run}-rabbitmq`,
  RABBITMQ_VOLUME: `${run}-data`,
  RABBITMQ_SERVICES: 'audit-service auth-service notification-service organization-service',
  NOTIFICATION_CONTAINMENT_STATE: latchPath(latchDir),
};
const BROKER = env.RABBITMQ_CONTAINER;
const AUDIT_QUEUE = 'audit-service.audit'; // apps/audit-service/src/ingestion/ingestion.constants.ts
const NOTIFICATION_BINDINGS = ['member.contact_verification_requested', 'admin.operator_code_issued', 'membership.approved'];

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ctl = (...args) => docker('exec', '-u', 'rabbitmq', BROKER, 'rabbitmqctl', '-q', ...args);
const provision = () => execFileSync('bash', [join(root, 'infra/rabbitmq/provision.sh')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${env.CORE_NETWORK}").IPAddress}}`, BROKER).trim();
// The client files address the broker by container name (Docker DNS); from the host the test dials the container's address instead.
const urlOf = (svc) => readFileSync(join(env.BROKER_DIR, 'clients', `${svc}.env`), 'utf8').trim().replace('RABBITMQ_URL=', '').replace(`@${BROKER}:`, `@${ip()}:`);
const adminUrl = () => {
  const f = readFileSync(join(env.BROKER_DIR, 'rabbitmq.env'), 'utf8');
  const get = (k) => f.match(new RegExp(`^${k}=(.*)$`, 'm'))[1];
  return `amqp://${get('RABBITMQ_DEFAULT_USER')}:${get('RABBITMQ_DEFAULT_PASS')}@${ip()}:5672/nawara-core`;
};
const bus = (svc, extra = {}) => new RabbitMqEventBus({ url: urlOf(svc), connectTimeoutMs: 3000, confirmTimeoutMs: 3000, onNotice: () => {}, ...extra });
const event = (name, source = 'auth-service') => ({ id: randomUUID(), name, payload: { probe: true }, headers: { eventId: randomUUID(), occurredAt: new Date().toISOString(), source, version: 1 } });
const queueDepth = (q) => {
  const row = ctl('list_queues', '-p', 'nawara-core', 'name', 'messages', '--no-table-headers').split('\n').map((l) => l.split('\t')).find(([n]) => n === q);
  return row ? Number(row[1]) : undefined;
};
/** Resolves with the error the broker raised on the channel (ACCESS_REFUSED, PRECONDITION_FAILED), or undefined if none. */
async function brokerRefusal(url, op) {
  const conn = await amqp.connect(url);
  conn.on('error', () => {});
  const ch = await conn.createConfirmChannel();
  let refused;
  ch.on('error', (e) => { refused ??= e; });
  try { await op(ch); await sleep(300); } catch (e) { refused ??= e; }
  await conn.close().catch(() => {});
  return refused;
}
async function until(predicate, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return true; await sleep(100); }
  return false;
}
const open = [];
const track = (b) => (open.push(b), b);

before(() => {
  writeTestLatch(latchDir, LATCH_STATE.inactive);
  const out = provision();
  // Notification was granted only after its real pre-grant gate PASSED (and its post-grant check after the grant)
  assert.match(out, /topology pre-grant notification-service: \{[^\n]*"result":"PASS"/);
  assert.match(out, /topology post-grant notification-service: \{[^\n]*"result":"PASS"/);
});
after(async () => {
  for (const b of open) await b.close().catch(() => {});
  docker('rm', '-f', BROKER);
  docker('volume', 'rm', env.RABBITMQ_VOLUME);
  docker('network', 'rm', env.CORE_NETWORK);
  rmSync(env.BROKER_DIR, { recursive: true, force: true });
  removeTestLatch(latchDir);
  rmSync(latchDir, { recursive: true, force: true });
});

test('guest does not exist: the default credentials are refused', async () => {
  await assert.rejects(amqp.connect(`amqp://guest:guest@${ip()}:5672/nawara-core`));
});

test('ORDERING HAZARD: an audit event published before the audit queue is bound is confirmed and silently dropped', async () => {
  const auth = track(bus('auth-service'));
  const early = event('audit.owner.factor_enrolled');
  await auth.publish(early); // resolves: the broker CONFIRMED it (the relay would now mark the outbox row published)
  const audit = track(bus('audit-service'));
  const seen = [];
  await audit.subscribe({ queue: AUDIT_QUEUE, bindings: ['audit.#'], handler: async (e) => { seen.push(e.id); } });
  await sleep(500);
  assert.equal(seen.includes(early.id), false, 'the early event must be gone: this is why Auth may never relay before Audit is bound');
  await audit.close();
});

test('audit-service declares its canonical topology under its least-privilege identity', () => {
  const queues = ctl('list_queues', '-p', 'nawara-core', 'name', 'durable', 'arguments', '--no-table-headers');
  assert.match(queues, /^audit-service\.audit\ttrue\t.*x-dead-letter-exchange.*nawara\.events\.dlx/m);
  assert.match(queues, /^audit-service\.audit\.retry\ttrue\t.*x-dead-letter-routing-key.*audit-service\.audit/m);
  assert.match(queues, /^audit-service\.audit\.dead\ttrue/m);
  const bindings = ctl('list_bindings', '-p', 'nawara-core', 'source_name', 'destination_name', 'routing_key', '--no-table-headers');
  assert.match(bindings, /^nawara\.events\taudit-service\.audit\taudit\.#$/m);
  assert.match(bindings, /^nawara\.events\.dlx\taudit-service\.audit\.dead\t$/m);
});

test('Auth publishes audit evidence and Audit receives it; a failing delivery is retried then dead-lettered (audit permissions)', async () => {
  const audit = track(bus('audit-service', { retry: { maxRetries: 1, delayMs: 200 } }));
  const seen = [];
  await audit.subscribe({
    queue: AUDIT_QUEUE, bindings: ['audit.#'],
    handler: async (e) => { if (e.name === 'audit.owner.factor_removed') throw new Error('probe failure'); seen.push(e.id); },
  });
  const auth = track(bus('auth-service'));
  const ok = event('audit.owner.password_changed');
  await auth.publish(ok);
  assert.ok(await until(() => seen.includes(ok.id)), 'the audit event must arrive');
  const deadBefore = queueDepth('audit-service.audit.dead') ?? 0;
  await auth.publish(event('audit.owner.factor_removed'));
  assert.ok(await until(() => queueDepth('audit-service.audit.dead') === deadBefore + 1), 'retry (via .retry) then dead-letter (.dead) must both be permitted');
  await audit.close();
});

test('Auth may publish ONLY its own audit actions (exact generated topic grants, S1d-2): a domain event, another producer\'s audit action and an uncataloged key are refused', async () => {
  const auth = track(bus('auth-service'));
  await assert.rejects(auth.publish(event('membership.approved')), 'AUTH_EVENTS=off: a domain event must be refused by the broker');
  await assert.rejects(track(bus('auth-service')).publish(event('audit.payment.succeeded')), 'another producer\'s audit action must be refused');
  await assert.rejects(track(bus('auth-service')).publish(event('audit.probe.uncataloged')), 'an uncataloged key must be refused');
  await auth.publish(event('audit.owner.secret_key_rotated')); // the bus recovers its channel; audit evidence still flows
  const url = urlOf('auth-service');
  assert.match(String((await brokerRefusal(url, (ch) => ch.assertQueue('rogue-queue')))?.message), /ACCESS_REFUSED/);
  assert.match(String((await brokerRefusal(url, (ch) => ch.consume(AUDIT_QUEUE, () => {})))?.message), /ACCESS_REFUSED/);
  assert.match(String((await brokerRefusal(url, (ch) => ch.deleteQueue(AUDIT_QUEUE)))?.message), /ACCESS_REFUSED/);
});

test('Audit cannot publish to the event exchange (it is a consumer only)', async () => {
  const refusal = await brokerRefusal(urlOf('audit-service'), async (ch) => {
    ch.publish('nawara.events', 'audit.forged', Buffer.from('{}'));
    await ch.waitForConfirms();
  });
  assert.match(String(refusal?.message), /ACCESS_REFUSED/);
});

test('an audit-only producer (organization-service) publishes its own audit actions and nothing else', async () => {
  const org = track(bus('organization-service'));
  await org.publish(event('audit.company.created', 'organization-service'));
  await assert.rejects(track(bus('organization-service')).publish(event('audit.owner.factor_enrolled', 'organization-service')));
  await assert.rejects(org.publish(event('payment.succeeded', 'organization-service')));
});

test('notification-service declares its intake queue for its own bindings and cannot bind to audit.*', async () => {
  const notification = track(bus('notification-service'));
  // its approved isolated topology (OD-BRK-2a): the subscription Notification itself makes
  const sub = await notification.subscribe({ queue: 'notification.events', bindings: NOTIFICATION_BINDINGS, handler: async () => {}, brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) });
  await sub.close();
  const refusal = await brokerRefusal(urlOf('notification-service'), (ch) => ch.bindQueue('notification.events', 'nawara.events', 'audit.#'));
  assert.match(String(refusal?.message), /ACCESS_REFUSED/);
});

test('OD-BRK-2a: a missing, contained or untrusted latch refuses Notification at its pre-grant gate and changes nothing; the valid one passes again', () => {
  const perms = () => ctl('list_permissions', '-p', 'nawara-core', '--no-table-headers').split('\n').find((l) => l.startsWith('notification-service\t'));
  const before = perms();
  assert.ok(before, 'Notification holds its grant');
  const untrusted = mkdtempSync(join(tmpdir(), `${run}-untrusted-`)); // the invoking (non-root) user's own file: never trusted
  try {
    mkdirSync(join(untrusted, 'latch'), { mode: 0o755 });
    writeFileSync(join(untrusted, 'latch', 'notification-service.containment'), LATCH_STATE.inactive, { mode: 0o644 });
    for (const [what, state, prepare] of [
      ['missing', join(latchDir, 'absent', 'notification-service.containment'), () => {}],
      ['not root-owned', join(untrusted, 'latch', 'notification-service.containment'), () => {}],
      ['contained', latchPath(latchDir), () => writeTestLatch(latchDir, LATCH_STATE.contained)],
      ['malformed', latchPath(latchDir), () => writeTestLatch(latchDir, 'state=inactive')],
    ]) {
      prepare();
      const r = spawnSync('bash', [join(root, 'infra/rabbitmq/provision.sh')], { env: { ...env, RABBITMQ_SERVICES: 'notification-service', NOTIFICATION_CONTAINMENT_STATE: state }, encoding: 'utf8', timeout: 240_000 });
      const out = `${r.stdout}${r.stderr}`;
      assert.notEqual(r.status, 0, `${what}: ${out}`);
      assert.match(out, /notification-service NOT provisioned: the pre-grant topology verification did not pass/, what);
      assert.doesNotMatch(out, /"result":"PASS"/, what);
      assert.equal(perms(), before, `${what}: the existing grant is unchanged`);
    }
  } finally {
    rmSync(untrusted, { recursive: true, force: true });
    writeTestLatch(latchDir, LATCH_STATE.inactive);
  }
});

test('queued evidence survives recreating the broker container (fixed hostname + volume) and provisioning is idempotent', async () => {
  const auth = track(bus('auth-service'));
  await auth.publish(event('audit.account.disabled')); // the audit queue exists and has no consumer now: the message waits
  assert.ok(await until(() => (queueDepth(AUDIT_QUEUE) ?? 0) >= 1));
  const before = queueDepth(AUDIT_QUEUE);
  await auth.close();
  docker('rm', '-f', BROKER);
  const out = provision(); // recreates the container on the same volume, converges users and permissions again
  assert.doesNotMatch(out, /identity .* \(new\)/, 'stored identities are reused, not regenerated');
  assert.equal(queueDepth(AUDIT_QUEUE), before, 'the persistent messages of the durable queue must still be there');
});

test('a queue declared with different arguments makes Audit fail to start (mismatch is detected, never papered over)', async () => {
  const admin = await amqp.connect(adminUrl());
  const ch = await admin.createChannel();
  await ch.deleteQueue(AUDIT_QUEUE);
  await ch.assertQueue(AUDIT_QUEUE, { durable: true }); // no x-dead-letter-exchange: not the canonical declaration
  await admin.close();
  const audit = track(bus('audit-service'));
  await assert.rejects(audit.subscribe({ queue: AUDIT_QUEUE, bindings: ['audit.#'], handler: async () => {} }), /PRECONDITION_FAILED|inequivalent/);
});

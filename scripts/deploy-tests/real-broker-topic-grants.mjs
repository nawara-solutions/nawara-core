// Core V2 S1d-3 (ADR-0057 S0-C5): real-broker certification of the GENERATED topic grants, against a LOCAL Docker daemon only:
//   npm run test:deploy:real-broker            (needs Docker on Linux and a built @nawara/service-kit)
//
// One isolated broker, provisioned by the AUTHENTIC infra/rabbitmq/provision.sh (container, network, volume and state dir all prefixed
// `rbtopic-<pid>`, removed at the end, nothing else touched). The expected policy is the S1d-1 generator's output for the repository's own
// contracts, audit catalog and reviewed activation file; the broker's effective grants are read back with rabbitmqctl and compared with
// it. Publishes go through the REAL service-kit bus under each service identity; every refusal is observed as the broker's own channel
// error (ACCESS_REFUSED 403 / PRECONDITION_FAILED 406), never a client-side check, and an observer queue bound to `#` proves a refused
// message was never routed. Two TEST-ONLY variants of the script (Auth domain events active; a Payment grant without one event) are the
// real script with only its generated block re-rendered by the real renderer: the production activation file is never changed.
// Payloads are synthetic (`{ synthetic: true }`): no code, credential or personal data. Secrets are never printed.
// Core V2 OD-BRK-2a: Notification is provisioned only through its real topology gate (a TEST-ONLY, root-owned, inactive latch in the run's
// own directory, lib/test-latch.mjs), holds the ISOLATED consumer role (no `nawara.events.dlx`) and subscribes with its isolated topology.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACTIVATION_FILE, DENY_ALL, generateTopicPermissions, generatedBlockOf, renderProvisionTopicGrants } from '../lib/topic-permissions.mjs';
import { LATCH_STATE, latchPath, removeTestLatch, writeTestLatch } from './lib/test-latch.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const kit = require(join(root, 'libs/service-kit/dist/index.js'));
const { RabbitMqEventBus, ProducerReemission, reemissionPolicy, replayDeadLetter, noBrokerDeadLettering } = kit;
const amqp = require('amqplib');

// ------------------------------------------------------------------------------------------------ the policy (generated, never restated)
const APPS = readdirSync(join(root, 'apps'));
const CONTRACTS = Object.fromEntries(APPS.filter((a) => existsSync(join(root, 'apps', a, 'contracts/events.json'))).map((a) => [a, readFileSync(join(root, 'apps', a, 'contracts/events.json'), 'utf8')]));
const CATALOG = readFileSync(join(root, 'libs/audit-contract/src/catalog.ts'), 'utf8');
const ACTIVATION = JSON.parse(readFileSync(join(root, ACTIVATION_FILE), 'utf8'));
const generate = (over = {}) => generateTopicPermissions({ contracts: CONTRACTS, auditCatalog: CATALOG, apps: APPS, activation: ACTIVATION, ...over }).identities;
const GEN = generate();
const ALL = Object.keys(GEN).sort();
const PRODUCERS = ['auth-service', 'billing-service', 'file-service', 'organization-service', 'payment-service', 'release-service'];
const contractOf = (svc) => JSON.parse(CONTRACTS[svc]);
const AUTH_DOMAIN = contractOf('auth-service').produces.map((e) => e.name).sort();
const NOTIFICATION_BINDINGS = contractOf('notification-service').consumes.map((e) => e.name).sort();
const BILLING_BINDINGS = contractOf('billing-service').consumes.map((e) => e.name).sort();

// ------------------------------------------------------------------------------------------------ the disposable broker
const run = `rbtopic-${process.pid}`;
const variants = mkdtempSync(join(tmpdir(), `${run}-variants-`)); // test-only scripts (no secret)
const latchDir = mkdtempSync(join(tmpdir(), `${run}-latch-`)); // holds only the root-owned test latch
const env = {
  ...process.env,
  BROKER_DIR: mkdtempSync(join(tmpdir(), `${run}-state-`)),
  CORE_NETWORK: `${run}-internal`,
  RABBITMQ_CONTAINER: `${run}-rabbitmq`,
  RABBITMQ_VOLUME: `${run}-data`,
  NOTIFICATION_CONTAINMENT_STATE: latchPath(latchDir),
};
delete env.RABBITMQ_SERVICES; // the default selection is the script's own
const BROKER = env.RABBITMQ_CONTAINER;
const SCRIPT = join(root, 'infra/rabbitmq/provision.sh');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ctl = (...args) => docker('exec', '-u', 'rabbitmq', BROKER, 'rabbitmqctl', '-q', ...args);
/** Runs a provisioning script; `services` undefined = the script's default selection. Never throws: the caller checks the status. */
const provision = (script = SCRIPT, services) => {
  const r = spawnSync('bash', [script], { env: services === undefined ? env : { ...env, RABBITMQ_SERVICES: services }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
/** The real script with ONLY its generated block re-rendered (by the real renderer) for a test-only policy. */
const variantScript = (name, over) => {
  const text = readFileSync(SCRIPT, 'utf8');
  const current = generatedBlockOf(text);
  const block = renderProvisionTopicGrants(generateTopicPermissions({ contracts: CONTRACTS, auditCatalog: CATALOG, apps: APPS, activation: ACTIVATION, ...over }));
  const at = text.indexOf(current);
  const file = join(variants, `${name}.sh`);
  writeFileSync(file, text.slice(0, at) + block + text.slice(at + current.length));
  return file;
};
const ip = () => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${env.CORE_NETWORK}").IPAddress}}`, BROKER).trim();
const urlOf = (svc) => readFileSync(join(env.BROKER_DIR, 'clients', `${svc}.env`), 'utf8').trim().replace('RABBITMQ_URL=', '').replace(`@${BROKER}:`, `@${ip()}:`);
const adminUrl = () => {
  const f = readFileSync(join(env.BROKER_DIR, 'rabbitmq.env'), 'utf8');
  const get = (k) => f.match(new RegExp(`^${k}=(.*)$`, 'm'))[1];
  return `amqp://${get('RABBITMQ_DEFAULT_USER')}:${get('RABBITMQ_DEFAULT_PASS')}@${ip()}:5672/nawara-core`;
};
const secrets = () => readdirSync(join(env.BROKER_DIR, 'clients')).map((f) => readFileSync(join(env.BROKER_DIR, 'clients', f), 'utf8').match(/:([0-9a-f]{64})@/)[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(50);
  }
  return false;
}
const open = [];
const track = (x) => (open.push(x), x);
const bus = (svc, extra = {}) => track(new RabbitMqEventBus({ url: urlOf(svc), connectTimeoutMs: 3000, confirmTimeoutMs: 3000, onNotice: () => {}, ...extra }));
const event = (name, source, id = randomUUID()) => ({ id, name, payload: { synthetic: true }, headers: { eventId: id, occurredAt: new Date().toISOString(), source, version: 1 } });

/** The broker's answer to one raw publish (or bind) on a fresh confirm channel: undefined when accepted, else its channel error. */
const connections = new Map();
async function connectionOf(svc) {
  if (!connections.has(svc)) {
    const c = await amqp.connect(svc === 'admin' ? adminUrl() : urlOf(svc));
    c.on('error', () => {});
    connections.set(svc, track(c));
  }
  return connections.get(svc);
}
async function brokerAnswer(svc, op) {
  const ch = await (await connectionOf(svc)).createConfirmChannel();
  let refused;
  ch.on('error', (e) => { refused ??= e; });
  try {
    await op(ch);
    await ch.waitForConfirms();
  } catch (e) {
    refused ??= e;
  }
  await sleep(20);
  await ch.close().catch(() => {});
  return refused;
}
const rawPublish = (svc, exchange, key, props = {}) => brokerAnswer(svc, async (ch) => {
  const id = props.messageId ?? randomUUID();
  ch.publish(exchange, key, Buffer.from('{"synthetic":true}'), { persistent: true, messageId: id, type: key, userId: svc, ...props });
});
const assertTopicRefused = (e, what) => {
  assert.equal(e?.code, 403, `${what}: expected the broker's ACCESS_REFUSED, got ${e?.code} ${e?.message ?? 'accepted'}`);
  assert.match(String(e.message), /ACCESS_REFUSED/, what);
};

// The observer: a queue bound to every key of the exchange (admin), so "never routed" is checked, not assumed.
let tap;
const tapped = new Map();
async function tapSince(predicate, ms = 400) {
  await sleep(ms);
  return [...tapped.values()].filter(predicate);
}

before(async () => {
  // the run's own resources only; refuse to start if any already exists (never adopt or reuse someone else's)
  for (const [kind, name] of [['container', BROKER], ['network', env.CORE_NETWORK], ['volume', env.RABBITMQ_VOLUME]]) {
    assert.ok(spawnSync('docker', [kind, 'inspect', name]).status !== 0, `${kind} ${name} already exists: refusing to use it`);
  }
  writeTestLatch(latchDir, LATCH_STATE.inactive);
});
after(async () => {
  for (const x of open.reverse()) await x.close().catch(() => {});
  // exactly the resources this run created, by their unique names
  spawnSync('docker', ['rm', '-f', BROKER]);
  spawnSync('docker', ['volume', 'rm', env.RABBITMQ_VOLUME]);
  spawnSync('docker', ['network', 'rm', env.CORE_NETWORK]);
  rmSync(env.BROKER_DIR, { recursive: true, force: true });
  rmSync(variants, { recursive: true, force: true });
  removeTestLatch(latchDir);
  rmSync(latchDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ provisioning

test('provisioning: the default selection creates only Audit and Auth; Billing and Payment exist only when selected', () => {
  const r = provision();
  assert.equal(r.code, 0, r.out);
  const users = ctl('list_users', '--no-table-headers').split('\n').map((l) => l.split('\t')[0]).filter(Boolean).sort();
  assert.deepEqual(users, ['audit-service', 'auth-service', 'nawara-admin']);
  for (const s of secrets()) assert.ok(!r.out.includes(s), 'no secret is printed');
});

test('provisioning: an unknown service is refused and changes nothing', () => {
  const before = ctl('list_users', '--no-table-headers');
  const r = provision(SCRIPT, 'audit-service ghost-service');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no broker identity is defined for 'ghost-service'.*nothing was changed/);
  assert.equal(ctl('list_users', '--no-table-headers'), before);
});

const ROLE_PERMS = {
  producer: { conf: '^nawara\\.events$', write: '^nawara\\.events$', read: '^$' },
  consumer: (q) => {
    const e = q.replaceAll('.', '\\.');
    return { conf: `^(nawara\\.events|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$`, write: `^(amq\\.default|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$`, read: `^(nawara\\.events|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$` };
  },
  // OD-BRK-2a: the consumer role WITHOUT the shared dead-letter exchange (no configure, write or read on `nawara.events.dlx`)
  isolated: (q) => {
    const e = q.replaceAll('.', '\\.');
    return { conf: `^(nawara\\.events|${e}|${e}\\.retry|${e}\\.dead)$`, write: `^(amq\\.default|${e}|${e}\\.retry|${e}\\.dead)$`, read: `^(nawara\\.events|${e}|${e}\\.retry|${e}\\.dead)$` };
  },
};
const expectedResource = (svc) => {
  if (svc === 'audit-service') return ROLE_PERMS.consumer('audit-service.audit');
  if (svc === 'notification-service') return ROLE_PERMS.isolated('notification.events');
  if (svc === 'billing-service') {
    const c = ROLE_PERMS.consumer('billing.payment-events');
    return { ...c, write: c.write.replace('^(amq\\.default|', '^(amq\\.default|nawara\\.events|') };
  }
  return ROLE_PERMS.producer;
};
function effectiveGrants() {
  const perms = Object.fromEntries(ctl('list_permissions', '-p', 'nawara-core', '--no-table-headers').split('\n').filter(Boolean).map((l) => {
    const [user, conf, write, read] = l.split('\t');
    return [user, { conf, write, read }];
  }));
  const topic = Object.fromEntries(ctl('list_topic_permissions', '-p', 'nawara-core', '--no-table-headers').split('\n').filter(Boolean).map((l) => {
    const [user, exchange, write, read] = l.split('\t');
    return [user, { exchange, write, read }];
  }));
  const users = ctl('list_users', '--no-table-headers').split('\n').filter(Boolean).map((l) => l.split('\t'));
  return { perms, topic, users };
}
function assertGrantsAre(policy, selected) {
  const g = effectiveGrants();
  assert.deepEqual(g.users.map(([u]) => u).sort(), [...selected, 'nawara-admin'].sort(), 'no unexpected user');
  for (const [u, tags] of g.users) if (u !== 'nawara-admin') assert.equal(tags.replace(/[[\]]/g, '').trim(), '', `${u}: no tag (no impersonator)`);
  for (const svc of selected) {
    assert.deepEqual(g.topic[svc], { exchange: 'nawara.events', write: policy[svc].write.regex, read: policy[svc].read.regex }, `${svc}: topic grants = generated`);
    assert.deepEqual(g.perms[svc], expectedResource(svc), `${svc}: resource permissions of its role`);
  }
  assert.deepEqual(Object.keys(g.topic).sort(), [...selected].sort(), 'no topic grant for anyone else (the administrator has none)');
  for (const t of Object.values(g.topic)) for (const r of [t.write, t.read]) assert.ok(r === DENY_ALL || /^\^\(([a-z0-9_]+(\\\.[a-z0-9_#]+)+)(\|[a-z0-9_]+(\\\.[a-z0-9_#]+)+)*\)\$$/.test(r), `not exact: ${r}`);
}

test('provisioning: every identity selected gets EXACTLY its generated topic grants and its role\'s resource permissions (read back from the broker)', () => {
  const r = provision(SCRIPT, ALL.join(' '));
  assert.equal(r.code, 0, r.out);
  assertGrantsAre(GEN, ALL);
  assert.equal(GEN['auth-service'].domainEvents, 'inactive');
  assert.deepEqual(Object.fromEntries(ALL.map((s) => [s, [GEN[s].write.keys.length, GEN[s].read.keys.length]])), {
    // auth-service: 28 + the three authorization receipt actions (Core V2 S2-Audit.2, D1); file-service: 2 + the two evidence-grant actions (S2-File.1) + file.granted_read (S2-File.2) + the two hold actions (S2-File.3); billing-service: 12 + the three assistance-request actions (S5a, D-9) + the three settlement / cash-return actions (S5b, E-13) + the five confirmation / dispute / correction actions (S5c) + the two refund-case actions (S6a) + refund_case.authorization_relayed (S6b) + refund_case.completed (S6c) + subscription_purchase.reversed (S6d), reading + refund.case_completed (S6c); payment-service: 10 + the three refund-attempt actions (S6b, R6B-7) + refund_authorization.completed and refund.case_completed (S6c) + the four payment_dispute actions and payment.dispute.opened / lost (S6e-D); billing-service reading + payment.dispute.lost (S6e-D), writing + the three fraud_hold actions (S6e-H)
    'audit-service': [0, 1], 'auth-service': [31, 0], 'billing-service': [45, 7], 'file-service': [7, 0], 'notification-service': [0, 9],
    'organization-service': [7, 0], 'payment-service': [23, 0], 'release-service': [4, 0],
  });
});

test('provisioning: a re-run is idempotent (no new identity, no rotated secret, the same grants)', () => {
  const before = { secrets: secrets().sort(), grants: effectiveGrants() };
  const r = provision(SCRIPT, ALL.join(' '));
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /\(new\)/);
  assert.deepEqual(secrets().sort(), before.secrets);
  assert.deepEqual(effectiveGrants(), before.grants);
});

// ------------------------------------------------------------------------------------------------ consumers attach, then producers publish

const received = { audit: new Map(), billing: new Map(), notification: new Map() };
let billingFail = new Set();
test('consumers: Audit binds `audit.#`, Billing its four Payment events and Notification its nine names, each under its own identity', async () => {
  const admin = await connectionOf('admin');
  const ch = track(await admin.createChannel());
  tap = `${run}.tap`;
  // the exchanges as the kit declares them (a fresh broker has none until a service connects)
  await ch.assertExchange('nawara.events', 'topic', { durable: true });
  await ch.assertExchange('nawara.events.dlx', 'fanout', { durable: true });
  await ch.assertQueue(tap, { durable: false, autoDelete: true });
  await ch.bindQueue(tap, 'nawara.events', '#');
  await ch.consume(tap, (m) => tapped.set(m.properties.messageId, { key: m.fields.routingKey, userId: m.properties.userId }), { noAck: true });
  await bus('audit-service').subscribe({ queue: 'audit-service.audit', bindings: ['audit.#'], handler: async (e) => { received.audit.set(e.id, e.name); } });
  await bus('billing-service', { retry: { maxRetries: 1, delayMs: 200 } }).subscribe({
    queue: 'billing.payment-events', bindings: BILLING_BINDINGS,
    handler: async (e) => {
      if (billingFail.has(e.id)) throw new Error('synthetic failure');
      received.billing.set(e.id, e.name);
    },
  });
  await bus('notification-service').subscribe({ queue: 'notification.events', bindings: NOTIFICATION_BINDINGS, handler: async (e) => { received.notification.set(e.id, e.name); }, brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) });
  const bindings = ctl('list_bindings', '-p', 'nawara-core', 'source_name', 'destination_name', 'routing_key', '--no-table-headers');
  assert.match(bindings, /^nawara\.events\taudit-service\.audit\taudit\.#$/m);
  for (const k of BILLING_BINDINGS) assert.match(bindings, new RegExp(`^nawara\\.events\\tbilling\\.payment-events\\t${k.replaceAll('.', '\\.')}$`, 'm'));
  for (const k of NOTIFICATION_BINDINGS) assert.match(bindings, new RegExp(`^nawara\\.events\\tnotification\\.events\\t${k.replaceAll('.', '\\.')}$`, 'm'));
  assert.equal(NOTIFICATION_BINDINGS.length, 9);
  // OD-BRK-2a: Notification's private dead queue is never bound to the shared fanout (Audit's and Billing's still are: unchanged)
  assert.doesNotMatch(bindings, /^nawara\.events\.dlx\tnotification\.events\.dead\t/m);
  assert.match(bindings, /^nawara\.events\.dlx\taudit-service\.audit\.dead\t$/m);
  assert.match(bindings, /^nawara\.events\.dlx\tbilling\.payment-events\.dead\t$/m);
});

test('producers: each of the six publishes EVERY key of its generated grant, carried with its own user_id', async () => {
  const sent = new Map();
  for (const svc of PRODUCERS) {
    const b = bus(svc);
    for (const key of GEN[svc].write.keys) {
      const e = event(key, svc);
      await b.publish(e); // resolves only on the broker's confirm
      sent.set(e.id, { svc, key });
    }
  }
  // every generated write key, exactly once (the literal 63 had gone stale as stages added actions; the per-service counts are pinned above)
  assert.equal(sent.size, PRODUCERS.reduce((n, svc) => n + GEN[svc].write.keys.length, 0));
  assert.ok(await until(async () => [...sent.keys()].every((id) => tapped.has(id))), 'every authorized publish is routed');
  for (const [id, { svc, key }] of sent) assert.deepEqual(tapped.get(id), { key, userId: svc });
  // delivery: Audit receives every audit action; Billing exactly the four Payment events it binds (never payment.created)
  const auditSent = [...sent].filter(([, s]) => s.key.startsWith('audit.')).map(([id]) => id);
  assert.ok(await until(() => auditSent.every((id) => received.audit.has(id))), 'Audit receives every authorized audit action');
  const payments = [...sent].filter(([, s]) => s.svc === 'payment-service' && !s.key.startsWith('audit.'));
  assert.ok(await until(() => payments.filter(([, s]) => s.key !== 'payment.created').every(([id]) => received.billing.has(id))), 'Billing receives its Payment events');
  assert.ok(!payments.some(([id, s]) => s.key === 'payment.created' && received.billing.has(id)));
  assert.equal(received.notification.size, 0, 'nothing reaches Notification while Auth domain events are inactive');
});

// ------------------------------------------------------------------------------------------------ refusals (the broker's own)

const OTHER_DOMAIN = { 'auth-service': 'payment.succeeded', 'billing-service': 'payment.succeeded', 'file-service': 'invoice.created', 'organization-service': 'payment.created', 'payment-service': 'invoice.created', 'release-service': 'membership.approved' };
const OTHER_AUDIT = { 'auth-service': 'audit.payment.succeeded', 'billing-service': 'audit.payment.created', 'file-service': 'audit.owner.factor_enrolled', 'organization-service': 'audit.file.deleted', 'payment-service': 'audit.invoice.issued', 'release-service': 'audit.company.created' };
test('refusals: every producer is refused by the BROKER for a foreign domain event, a foreign audit action, an unknown key, a suffix and a prefix variant, and other exchanges; nothing refused is routed', async () => {
  const refusedIds = [];
  for (const svc of PRODUCERS) {
    const own = GEN[svc].write.keys[0];
    const cases = [
      ['a foreign domain event', OTHER_DOMAIN[svc]], ['a foreign audit action', OTHER_AUDIT[svc]], ['an unknown event', 'unknown.synthetic_event'],
      ['a suffix variant', `${own}.x`], ['a prefix variant', `x.${own}`], ['a wildcard key', 'audit.#'], ['the empty key', ''],
    ];
    for (const [what, key] of cases) {
      assert.ok(!GEN[svc].write.keys.includes(key), `${svc} ${what} is not in its grant`);
      const id = randomUUID();
      refusedIds.push(id);
      assertTopicRefused(await rawPublish(svc, 'nawara.events', key, { messageId: id }), `${svc} ${what} (${key || '<empty>'})`);
    }
    // Billing is also a consumer: its write on the shared DLX is the documented OD-BRK residual (characterized below), not a refusal case
    for (const exchange of svc === 'billing-service' ? ['amq.topic', 'amq.direct'] : ['amq.topic', 'nawara.events.dlx', 'amq.direct']) {
      const e = await rawPublish(svc, exchange, own);
      assert.equal(e?.code, 403, `${svc} may not publish to ${exchange}`);
    }
  }
  assert.deepEqual(await tapSince((v) => refusedIds.includes(v)), []);
  assert.ok(refusedIds.every((id) => !tapped.has(id) && !received.audit.has(id) && !received.billing.has(id)), 'no refused message was routed or delivered');
});

test('Auth: the twelve inactive domain events (code-bearing ones included) are refused by the broker under the production activation file', async () => {
  assert.equal(AUTH_DOMAIN.length, 12);
  for (const key of AUTH_DOMAIN) assertTopicRefused(await rawPublish('auth-service', 'nawara.events', key), `auth-service ${key}`);
});

test('Payment: its five events and five audit actions publish; the unregistered re-emission action, other services\' keys and any topic READ are refused', async () => {
  assert.ok(GEN['payment-service'].write.keys.includes('payment.created'));
  assertTopicRefused(await rawPublish('payment-service', 'nawara.events', 'audit.payment.event_reemitted'), 'payment-service audit.payment.event_reemitted');
  for (const key of ['membership.approved', 'invoice.created', 'audit.company.created', 'audit.file.deleted', 'audit.release.published', 'audit.owner.factor_enrolled']) {
    assertTopicRefused(await rawPublish('payment-service', 'nawara.events', key), `payment-service ${key}`);
  }
  assert.equal(effectiveGrants().topic['payment-service'].read, DENY_ALL);
  const bind = await brokerAnswer('payment-service', async (ch) => {
    const { queue } = await ch.assertQueue('', { exclusive: true });
    await ch.bindQueue(queue, 'nawara.events', 'payment.succeeded');
  });
  assert.equal(bind?.code, 403, 'Payment may not declare or bind a queue');
});

test('Billing: its twelve keys publish (above); Payment\'s events, foreign audit actions and foreign bindings are refused', async () => {
  for (const key of ['payment.succeeded', 'payment.created', 'audit.payment.succeeded', 'audit.owner.factor_enrolled', 'membership.approved']) {
    assertTopicRefused(await rawPublish('billing-service', 'nawara.events', key), `billing-service ${key}`);
  }
  for (const key of ['member.contact_verification_requested', 'payment.#', 'payment.created', 'audit.#', '#']) {
    const e = await brokerAnswer('billing-service', (ch) => ch.bindQueue('billing.payment-events', 'nawara.events', key));
    assertTopicRefused(e, `billing-service may not bind ${key}`);
  }
});

test('Audit: binds `audit.#` (above) but publishes nothing, not even its own locally recorded action', async () => {
  assertTopicRefused(await rawPublish('audit-service', 'nawara.events', 'audit.platform_query.executed'), 'audit-service audit.platform_query.executed');
  assert.equal(effectiveGrants().topic['audit-service'].write, DENY_ALL);
});

test('Notification: publishes nothing and cannot widen its bindings by routing-key manipulation', async () => {
  for (const key of ['member.contact_verification_requested', 'audit.owner.factor_enrolled', 'x']) assertTopicRefused(await rawPublish('notification-service', 'nawara.events', key), `notification-service publishes ${key}`);
  for (const key of ['audit.#', 'member.#', '#', '*.*', 'user.registered']) {
    assertTopicRefused(await brokerAnswer('notification-service', (ch) => ch.bindQueue('notification.events', 'nawara.events', key)), `notification-service binds ${key}`);
  }
});

// ------------------------------------------------------------------------------------------------ identity (S1a)

test('identity: a forged user_id is refused (406); headers cannot claim another producer\'s grant; omitting user_id grants nothing', async () => {
  const forged = await rawPublish('auth-service', 'nawara.events', 'audit.owner.factor_enrolled', { userId: 'payment-service' });
  assert.equal(forged?.code, 406, 'PRECONDITION_FAILED: user_id differs from the authenticated user');
  assert.match(String(forged.message), /user_id/);
  // a `source` header naming Payment does not let Auth publish a Payment key
  assertTopicRefused(await rawPublish('auth-service', 'nawara.events', 'audit.payment.succeeded', { headers: { source: 'payment-service' } }), 'auth with a forged source header');
  // no user_id: the topic grant still applies
  assertTopicRefused(await rawPublish('auth-service', 'nawara.events', 'audit.payment.succeeded', { userId: undefined }), 'auth without user_id, foreign key');
  // RESIDUAL (recorded, not fixed by S1d): within its own grant, a message WITHOUT user_id is accepted and routed; consumers see it
  // unverified (`missing_user_id`, ADR-0057 §13.2) and only S1e enforcement refuses it.
  const id = randomUUID();
  assert.equal(await rawPublish('auth-service', 'nawara.events', 'audit.owner.factor_enrolled', { userId: undefined, messageId: id }), undefined);
  assert.ok(await until(() => tapped.has(id)));
  assert.equal(tapped.get(id).userId, undefined);
});

// ------------------------------------------------------------------------------------------------ retry, dead letter, replay

test('Billing\'s retry, dead-letter and replay work under its combined identity; which hop uses which grant is recorded', async () => {
  const e = event('payment.failed', 'payment-service');
  billingFail = new Set([e.id]);
  const dead = 'billing.payment-events.dead';
  const depth = (q) => Number(ctl('list_queues', '-p', 'nawara-core', 'name', 'messages', '--no-table-headers').split('\n').map((l) => l.split('\t')).find(([n]) => n === q)?.[1] ?? 0);
  const before = depth(dead);
  await bus('payment-service').publish(e);
  // handler fails → Billing copies it to `.retry` (DEFAULT exchange, Billing's amq.default write) → the broker expires it back to the work
  // queue (broker-internal dead-lettering: no user grant) → fails again → Billing copies it to `.dead` (default exchange again)
  assert.ok(await until(() => depth(dead) === before + 1, 10_000), 'retried then dead-lettered');
  billingFail = new Set();
  // `nawara-dlq replay` (the kit's replayDeadLetter) under Billing's own identity: default-exchange publish back to the work queue
  const conn = track(await amqp.connect(urlOf('billing-service')));
  const r = await replayDeadLetter(conn, dead, e.id, { waitMs: 5000 });
  assert.ok(['consumed', 'pending'].includes(r.outcome), r.outcome);
  assert.ok(await until(() => received.billing.has(e.id)), 'the replayed event is handled');
  assert.equal(depth(dead), before);
});

test('RESIDUAL (OD-BRK, characterized): a consumer identity can inject through the default exchange; the shared DLX no longer reaches Notification (OD-BRK-2a)', async () => {
  // default exchange: Notification (a consumer, no topic write at all) addresses Billing's work queue by name
  const injected = randomUUID();
  const viaDefault = await brokerAnswer('notification-service', async (ch) => {
    ch.sendToQueue('billing.payment-events', Buffer.from('{"synthetic":true}'), { messageId: injected, type: 'payment.succeeded', userId: 'notification-service', headers: { eventId: injected, source: 'payment-service', version: 1, occurredAt: new Date().toISOString() } });
  });
  assert.equal(viaDefault, undefined, 'accepted: amq.default write reaches any queue by name');
  assert.ok(await until(() => received.billing.has(injected)), 'and delivered to the Billing handler: only consumer enforcement (S1e) can refuse it');
  assert.equal(tapped.has(injected), false, 'never through nawara.events, so topic permissions never saw it');
  // shared fanout DLX, OD-BRK-2a: Notification's identity has NO permission on it, so the BROKER refuses its publish (403: an
  // authorization denial, before any routing; distinct from a consumer's provenance refusal, which happens after delivery)
  const deadIds = async (q) => {
    const c = track(await amqp.connect(adminUrl()));
    const i = await kit.inspectDeadLetters(c, q, { limit: 50 });
    return i.messages.map((m) => m.eventId);
  };
  const fromNotification = randomUUID();
  const viaDlx = await brokerAnswer('notification-service', async (ch) => {
    ch.publish('nawara.events.dlx', '', Buffer.from('{"synthetic":true}'), { messageId: fromNotification, userId: 'notification-service' });
  });
  assert.equal(viaDlx?.code, 403, `notification-service may not publish to nawara.events.dlx, got ${viaDlx?.code} ${viaDlx?.message ?? 'accepted'}`);
  assert.match(String(viaDlx.message), /ACCESS_REFUSED/);
  // the residual for the legacy consumers is unchanged (Billing still holds the fanout): one publish lands in Audit's and Billing's
  // dead-letter queues, but never in Notification's, which is not bound to the fanout
  const fromBilling = randomUUID();
  assert.equal(await brokerAnswer('billing-service', async (ch) => {
    ch.publish('nawara.events.dlx', '', Buffer.from('{"synthetic":true}'), { messageId: fromBilling, userId: 'billing-service' });
  }), undefined);
  for (const q of ['audit-service.audit.dead', 'billing.payment-events.dead']) assert.ok((await until(async () => (await deadIds(q)).includes(fromBilling))), `${q} received the legacy DLX injection`);
  const notificationDead = await deadIds('notification.events.dead');
  assert.ok(!notificationDead.includes(fromBilling) && !notificationDead.includes(fromNotification), 'nothing from the shared fanout reaches notification.events.dead');
  for (const q of ['audit-service.audit.dead', 'billing.payment-events.dead']) assert.ok(!(await deadIds(q)).includes(fromNotification), `${q}: the refused publish was never routed`);
});

// ------------------------------------------------------------------------------------------------ R1 producer re-emission compatibility

/** R1 with synthetic seams (no database, no R2b): only the publication is real, through Payment's own identity and grants. */
function reemission(row) {
  const attempts = [];
  const re = new ProducerReemission({
    policy: reemissionPolicy('payment-service', [{ name: 'payment.succeeded', version: 1 }, { name: 'payment.expired', version: 1 }]),
    environment: 'certification',
    db: { tx: async (fn) => fn({ query: async (sql) => ({ rows: sql.includes('FROM outbox') ? [{ ...row, payload: { synthetic: true } }] : [], rowCount: 1 }) }) },
    ownership: { confirm: async () => true },
    evidence: { pipelineVersionOf: async () => 1 },
    authorizer: { verify: async (req, ctx) => ({ ...req, ...ctx, approvalRef: 'certification-only' }) },
    attempts: { commitIntent: async (i) => (attempts.push(i), { attemptId: i.attemptId, intentCommitted: true, auditIntentRecorded: true }), appendTransition: async (t) => void attempts.push(t) },
    publisher: bus('payment-service'),
  });
  return { re, attempts };
}
const row = (name) => ({ id: randomUUID(), name, correlationId: null, eventVersion: 1, occurredAt: new Date(), publishedAt: new Date() });

test('R1: a re-emission publishes under Payment\'s ordinary grant with the original id; outside its grant the broker\'s refusal is classified', async () => {
  const ok = row('payment.succeeded');
  const { re } = reemission(ok);
  const r = await re.reemit({ eventId: ok.id, eventName: ok.name, reason: 'certification' });
  assert.deepEqual(r.publish, { outcome: 'confirmed' });
  assert.ok(await until(() => received.billing.get(ok.id) === 'payment.succeeded'), 'delivered with the ORIGINAL event id');
  assert.deepEqual(tapped.get(ok.id), { key: 'payment.succeeded', userId: 'payment-service' });
  // a TEST-ONLY variant: Payment's grant without payment.expired (its contract minus that event), provisioned by the real script
  const c = contractOf('payment-service');
  c.produces = c.produces.filter((e) => e.name !== 'payment.expired');
  const billing = contractOf('billing-service'); // the generator fails closed while a consumer still declares the removed event
  billing.consumes = billing.consumes.filter((e) => e.name !== 'payment.expired');
  const narrowed = variantScript('payment-without-expired', { contracts: { ...CONTRACTS, 'payment-service': JSON.stringify(c), 'billing-service': JSON.stringify(billing) } });
  assert.equal(provision(narrowed, 'payment-service').code, 0);
  const narrowedWrite = new RegExp(effectiveGrants().topic['payment-service'].write); // evaluated as the broker does
  assert.ok(!narrowedWrite.test('payment.expired') && narrowedWrite.test('payment.succeeded') && narrowedWrite.test('audit.payment.expired'));
  const out = row('payment.expired');
  const refused = await reemission(out).re.reemit({ eventId: out.id, eventName: out.name, reason: 'certification' });
  assert.deepEqual(refused.publish, { outcome: 'failed', stage: 'refused' }, 'the broker\'s 403 is a definite refusal, not uncertain');
  assert.equal(tapped.has(out.id), false);
  // the production script restores exactly the generated grant
  assert.equal(provision(SCRIPT, 'payment-service').code, 0);
  assert.equal(effectiveGrants().topic['payment-service'].write, GEN['payment-service'].write.regex);
});

// ------------------------------------------------------------------------------------------------ Auth activation (test-only variant)

test('Auth active (TEST-ONLY variant, production file unchanged): its 12 domain events publish, Notification receives exactly its nine; the production script narrows it back', async () => {
  const ACTIVE = { ...ACTIVATION, domainEvents: { ...ACTIVATION.domainEvents, 'auth-service': 'active' } };
  const activePolicy = generate({ activation: ACTIVE });
  assert.equal(activePolicy['auth-service'].write.keys.length, 43); // 31 audit actions (S2-Audit.2: +3) + 12 domain events
  assert.equal(provision(variantScript('auth-active', { activation: ACTIVE }), 'auth-service').code, 0);
  assert.equal(effectiveGrants().topic['auth-service'].write, activePolicy['auth-service'].write.regex);
  const auth = bus('auth-service');
  const ids = new Map();
  for (const key of AUTH_DOMAIN) {
    const e = event(key, 'auth-service'); // synthetic payload: no code, no contact data
    await auth.publish(e);
    ids.set(e.id, key);
  }
  const bound = [...ids].filter(([, k]) => NOTIFICATION_BINDINGS.includes(k)).map(([id]) => id);
  assert.equal(bound.length, 9);
  assert.ok(await until(() => bound.every((id) => received.notification.has(id))), 'Notification receives its nine intake events');
  assert.ok([...ids].filter(([, k]) => !NOTIFICATION_BINDINGS.includes(k)).every(([id]) => !received.notification.has(id)));
  assert.deepEqual(JSON.parse(readFileSync(join(root, ACTIVATION_FILE), 'utf8')), ACTIVATION, 'the production activation file is untouched');
  // the production script converges Auth back to its audit actions only
  assert.equal(provision(SCRIPT, 'auth-service').code, 0);
  assertTopicRefused(await rawPublish('auth-service', 'nawara.events', 'membership.approved'), 'auth-service after convergence');
});

test('final state: the broker\'s effective grants equal the generated production policy for every identity', () => {
  assertGrantsAre(GEN, ALL);
});

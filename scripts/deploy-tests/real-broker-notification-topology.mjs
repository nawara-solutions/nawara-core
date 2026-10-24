// Core V2 OD-BRK-2a (ADR-0057 §8 "OD-BRK-0", D1 to D3): real-broker certification of Notification's isolated topology, its effective-
// topology verifier and its fail-closed first-activation gate, against a LOCAL Docker daemon only:
//   npm run test:deploy:real-broker            (needs Docker on Linux and the built service-kit, audit-contract and notification-service)
//
// One isolated broker provisioned by the AUTHENTIC infra/rabbitmq/provision.sh (a TEST-ONLY variant with only its generated block
// re-rendered for Auth's domain events active, so a genuine Auth publication exists; the production activation file is never changed),
// one PostgreSQL 16 for a REAL Notification process, and a containment latch created ROOT-OWNED through the local Docker daemon (as the
// OD-BRK-2b installation will create it). Every resource is prefixed `rbnotif-<pid>`, refused if it already exists, and removed at the end
// by the ids this run recorded. Codes are synthetic; secrets are never printed. The verifier runs exactly as provisioning runs it.
// Every wait is bounded (each Docker command, connection, query, readiness poll, hook and test), the run's resources are written to
// RBNOTIF_MANIFEST (when set) as they are created, and the cleanup runs every step even after one fails (lib/owned-process.mjs).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ACTIVATION_FILE, generateTopicPermissions, generatedBlockOf, renderProvisionTopicGrants } from '../lib/topic-permissions.mjs';
import { bounded, cleanupAll, exited, stopChild, withCleanup } from './lib/owned-process.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const kit = require(join(root, 'libs/service-kit/dist/index.js'));
const amqp = require('amqplib');
const pg = require('pg');

const APPS = readdirSync(join(root, 'apps'));
const CONTRACTS = Object.fromEntries(APPS.filter((a) => existsSync(join(root, 'apps', a, 'contracts/events.json'))).map((a) => [a, readFileSync(join(root, 'apps', a, 'contracts/events.json'), 'utf8')]));
const CATALOG = readFileSync(join(root, 'libs/audit-contract/src/catalog.ts'), 'utf8');
const ACTIVATION = JSON.parse(readFileSync(join(root, ACTIVATION_FILE), 'utf8'));
const TEST_ACTIVATION = { ...ACTIVATION, domainEvents: { ...ACTIVATION.domainEvents, 'auth-service': 'active' } };
const GEN = generateTopicPermissions({ contracts: CONTRACTS, auditCatalog: CATALOG, apps: APPS, activation: TEST_ACTIVATION }).identities;
const SCRIPT = join(root, 'infra/rabbitmq/provision.sh');
const VERIFIER = join(root, 'infra/rabbitmq/verify-topology.sh');
const Q = 'notification.events';
const ROLE = {
  conf: '^(nawara\\.events|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$',
  write: '^(amq\\.default|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$',
};
const CODE = '804417';

const run = `rbnotif-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), `${run}-`));
const env = {
  ...process.env,
  BROKER_DIR: join(work, 'state'),
  CORE_NETWORK: `${run}-internal`,
  RABBITMQ_CONTAINER: `${run}-rabbitmq`,
  RABBITMQ_VOLUME: `${run}-data`,
  NOTIFICATION_CONTAINMENT_STATE: join(work, 'latch', 'notification-service.containment'),
};
const BROKER = env.RABBITMQ_CONTAINER;
const PG = `${run}-pg`;
const IMAGE = 'rabbitmq:3.13.7-alpine@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc';
const created = { containers: [], network: undefined, volume: undefined };
/** The run's own resources, on disk as soon as each exists: a stopped run is cleaned up by these ids, never by a name pattern. */
const record = () => {
  if (process.env.RBNOTIF_MANIFEST) writeFileSync(process.env.RBNOTIF_MANIFEST, `${JSON.stringify({ pid: process.pid, run, work, ...created })}\n`);
};
record();
const open = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL' });
const ctl = (...args) => docker('exec', '-u', 'rabbitmq', BROKER, 'rabbitmqctl', '-q', ...args);
const connect = async (url) => {
  const c = await amqp.connect(url, { timeout: 10_000 });
  open.push(c);
  return c;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 30_000, what = 'condition') => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      if (await bounded(cond(), 15_000, what)) return;
    } catch (e) {
      if (e?.fatal) throw e;
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`${what}: not met within ${ms} ms${last ? ` (last: ${String(last.message).replace(/:\/\/[^@\s]*@/g, '://<redacted>@').slice(0, 200)})` : ''}`);
};

/** The real script with ONLY its generated block re-rendered (Auth's domain events active): test-only, never written to the repository. */
const variant = (() => {
  const text = readFileSync(SCRIPT, 'utf8');
  const current = generatedBlockOf(text);
  const at = text.indexOf(current);
  const file = join(work, 'provision-auth-active.sh');
  writeFileSync(file, text.slice(0, at) + renderProvisionTopicGrants(generateTopicPermissions({ contracts: CONTRACTS, auditCatalog: CATALOG, apps: APPS, activation: TEST_ACTIVATION })) + text.slice(at + current.length));
  return file;
})();
const provision = (services, extraEnv = {}) => {
  const r = spawnSync('bash', [variant], { env: { ...env, RABBITMQ_SERVICES: services, ...extraEnv }, encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL' });
  return { code: r.status, out: `${r.stdout}${r.stderr}${r.error ? `\n[driver] provision.sh did not finish: ${r.error.message}` : ''}` };
};
/** The verifier, run as provisioning runs it (same container, same latch, the approved proposal and the generated grant). */
const verify = (phase, over = {}) => {
  const r = spawnSync('bash', [VERIFIER, 'notification-service', '--phase', phase], {
    env: { ...env, PROPOSED_PERM_CONF: ROLE.conf, PROPOSED_PERM_WRITE: ROLE.write, PROPOSED_PERM_READ: ROLE.conf, EXPECTED_TOPIC_WRITE: GEN['notification-service'].write.regex, EXPECTED_TOPIC_READ: GEN['notification-service'].read.regex, ...over },
    encoding: 'utf8',
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  let json;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    // the verifier prints only ids, names and reason codes: its output is safe to show
    throw new Error(`verifier gave no JSON result (status ${r.status}${r.error ? `, ${r.error.message}` : ''}): ${r.stdout.slice(-300)}${r.stderr.slice(-300)}`);
  }
  json.exit = r.status;
  json.check = (id) => json.checks.find((c) => c.id === id);
  return json;
};
/** The latch, written ROOT-OWNED (directory and file, 0755 / 0644) through the local daemon, as the OD-BRK-2b installation will. */
const latch = (content, mode = '644') => {
  docker('run', '--rm', '-v', `${work}:/w`, '--entrypoint', 'sh', IMAGE, '-c', `rm -rf /w/latch && mkdir -m 755 /w/latch && printf '%s' "$0" > /w/latch/notification-service.containment && chmod ${mode} /w/latch/notification-service.containment`, content);
};
const dropLatch = () => docker('run', '--rm', '-v', `${work}:/w`, '--entrypoint', 'sh', IMAGE, '-c', 'rm -rf /w/latch');
const INACTIVE = 'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive';
const ip = () => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${env.CORE_NETWORK}").IPAddress}}`, BROKER).trim();
const urlOf = (svc) => readFileSync(join(env.BROKER_DIR, 'clients', `${svc}.env`), 'utf8').trim().replace('RABBITMQ_URL=', '').replace(`@${BROKER}:`, `@${ip()}:`);
const adminUrl = () => {
  const f = readFileSync(join(env.BROKER_DIR, 'rabbitmq.env'), 'utf8');
  const get = (k) => f.match(new RegExp(`^${k}=(.*)$`, 'm'))[1];
  return `amqp://${get('RABBITMQ_DEFAULT_USER')}:${get('RABBITMQ_DEFAULT_PASS')}@${ip()}:5672/nawara-core`;
};
const perms = (user) => ctl('list_permissions', '-p', 'nawara-core', '--no-table-headers').split('\n').map((l) => l.split('\t')).find((l) => l[0] === user)?.slice(1);
const topic = (user) => ctl('list_topic_permissions', '-p', 'nawara-core', '--no-table-headers').split('\n').map((l) => l.split('\t')).find((l) => l[0] === user)?.slice(1);
const vhostMessages = () => ctl('list_queues', '-p', 'nawara-core', 'name', 'messages', '--no-table-headers').split('\n').filter(Boolean).reduce((n, l) => n + Number(l.split('\t')[1] || 0), 0);
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let pgUrl;
let notification;
let nport;
const startNotification = async () => {
  const lines = [];
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: join(root, 'apps/notification-service'),
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(nport), DATABASE_URL: pgUrl, RABBITMQ_URL: urlOf('notification-service'),
      NOTIFICATION_SECRET_KEYS: `k1:${randomBytes(32).toString('base64')}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1',
      NOTIFICATION_PROVENANCE_KEYS: `p1:${randomBytes(32).toString('base64')}`, NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p1',
      NOTIFICATION_DEFAULT_LOCALE: 'en', NOTIFICATION_REQUEST_HASH_KEY: randomBytes(32).toString('base64'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => lines.push(String(d)));
  child.stderr.on('data', (d) => lines.push(String(d)));
  notification = { child, lines };
  try {
    await waitFor(async () => {
      if (exited(child)) throw Object.assign(new Error(`Notification exited (${child.exitCode ?? child.signalCode}) before it was ready`), { fatal: true });
      return (await fetch(`http://127.0.0.1:${nport}/ready`, { signal: AbortSignal.timeout(5_000) })).status === 200;
    }, 60_000, 'Notification /ready');
  } catch (e) {
    // its own log tail (connection strings redacted) is the diagnosis of a setup failure
    const tail = lines.join('').split('\n').slice(-25).join('\n').replace(/(amqps?|postgres(ql)?):\/\/[^@\s]*@/g, '$1://<redacted>@');
    throw new Error(`${e.message}\n--- Notification output (tail) ---\n${tail}`);
  }
};
/** Stops the ONE Notification child this run spawned (already exited, normally or by a signal: nothing to wait for). */
const stopNotification = () => stopChild(notification?.child, { graceMs: 15_000, killMs: 5_000 });
const sql = async (text, params = []) => {
  const c = new pg.Client({ connectionString: pgUrl.replace(/\/[^/]*$/, '/s1notif'), connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
};
const envelope = (over = {}, id = randomUUID()) => ({
  id, name: 'admin.operator_code_issued',
  payload: { userId: `user-${id.slice(0, 8)}`, channel: 'email', destination: 'odbrk2a@example.test', code: CODE, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), timestamp: new Date().toISOString(), ...over },
  headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1, correlationId: `corr-${id.slice(0, 8)}` },
});

const exists = (kind, name) => spawnSync('docker', [kind, 'inspect', name], { timeout: 30_000, killSignal: 'SIGKILL' }).status === 0;

before(async () => {
  for (const [kind, name] of [['container', BROKER], ['container', PG], ['network', env.CORE_NETWORK], ['volume', env.RABBITMQ_VOLUME]]) {
    assert.ok(!exists(kind, name), `${kind} ${name} already exists: refusing to use it`);
  }
  // the broker and the other identities first (Notification is gated: tested below)
  const r = provision('audit-service auth-service billing-service payment-service');
  if (exists('container', BROKER)) created.containers.push(docker('inspect', '-f', '{{.Id}}', BROKER).trim());
  if (exists('network', env.CORE_NETWORK)) created.network = env.CORE_NETWORK;
  if (exists('volume', env.RABBITMQ_VOLUME)) created.volume = env.RABBITMQ_VOLUME;
  record();
  assert.equal(r.code, 0, r.out);
  const password = randomBytes(18).toString('hex');
  created.containers.push(docker('run', '-d', '--name', PG, '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:16-alpine').trim());
  record();
  pgUrl = `postgres://postgres:${password}@127.0.0.1:${docker('port', PG, '5432/tcp').trim().split('\n')[0].split(':').pop()}/postgres`;
  // the image's init phase answers `pg_isready` on a temporary server and then restarts it: retry until the real server takes the DDL
  await waitFor(async () => {
    const c = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
    c.on('error', () => {});
    try {
      await c.connect();
      await c.query('CREATE DATABASE s1notif');
      return true;
    } finally {
      await c.end().catch(() => {});
    }
  }, 90_000, 'PostgreSQL accepts CREATE DATABASE');
  pgUrl = pgUrl.replace(/\/postgres$/, '/s1notif');
  await bounded(kit.runMigrations(pgUrl, [kit.kitMigrationsDir, join(root, 'apps/notification-service/db/migrations/')]), 120_000, 'Notification migrations');
  nport = await freePort();
}, { timeout: 300_000 });

after(async () => {
  const rm = (...args) => async () => {
    const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.error?.message ?? r.stderr.trim().slice(0, 200)}`);
  };
  await cleanupAll([
    ['stop the Notification child', async () => { await stopNotification(); }],
    ...[...open].reverse().map((x, i) => [`close broker connection ${i}`, () => x.close().catch((e) => { if (!/closed/i.test(String(e?.message))) throw e; })]),
    ...[...created.containers].reverse().map((id) => [`remove container ${id.slice(0, 12)}`, rm('rm', '-f', id)]),
    ...(created.volume ? [[`remove volume ${created.volume}`, rm('volume', 'rm', created.volume)]] : []),
    ...(created.network ? [[`remove network ${created.network}`, rm('network', 'rm', created.network)]] : []),
    ['remove the root-owned latch', rm('run', '--rm', '-v', `${work}:/w`, '--entrypoint', 'sh', IMAGE, '-c', 'rm -rf /w/latch')],
    ['remove the work directory', async () => rmSync(work, { recursive: true, force: true })],
    ['confirm every resource is gone', async () => {
      for (const id of created.containers) assert.ok(!exists('container', id), `container ${id} was not removed`);
      if (created.volume) assert.ok(!exists('volume', created.volume), 'volume not removed');
      if (created.network) assert.ok(!exists('network', created.network), 'network not removed');
      assert.ok(!existsSync(work), 'work directory not removed');
    }],
  ], 90_000);
}, { timeout: 240_000 });

// ------------------------------------------------------------------------------------------------ the latch (17) and pre-grant (1-3)

test('17: no latch, a contained latch, a malformed one or one not root-owned: provisioning REFUSES and grants nothing', () => {
  dropLatch();
  for (const [label, prepare] of [
    ['absent', () => {}],
    ['contained', () => latch('nawara-core-topology-containment v1\nservice=notification-service\nstate=contained')],
    ['malformed', () => latch('state=inactive')],
    ['group-writable', () => latch(INACTIVE, '664')],
  ]) {
    prepare();
    const r = provision('notification-service');
    assert.notEqual(r.code, 0, `${label}: ${r.out}`);
    assert.match(r.out, /notification-service NOT provisioned: the pre-grant topology verification did not pass/, label);
    assert.equal(perms('notification-service'), undefined, `${label}: no grant`);
    assert.equal(topic('notification-service'), undefined, `${label}: no topic grant`);
  }
  // a latch owned by the invoking (non-root) user is never trusted either
  dropLatch();
  mkdirSync(join(work, 'latch'), { mode: 0o755 });
  writeFileSync(join(work, 'latch', 'notification-service.containment'), INACTIVE, { mode: 0o644 });
  assert.equal(verify('pre-grant').check('L1').status, 'UNKNOWN');
  rmSync(join(work, 'latch'), { recursive: true, force: true });
});

test('3: a broker command that cannot run is UNKNOWN, never PASS', () => {
  latch(INACTIVE);
  const v = verify('pre-grant', { RABBITMQ_CONTAINER: `${run}-no-such-broker` });
  assert.equal(v.result, 'UNKNOWN');
  assert.equal(v.exit, 3);
});

test('2: an unexpected REGULAR or OPERATOR policy (pattern and priority variants), or an exchange policy, fails pre-grant; a quorum-only one does not apply', async () => {
  latch(INACTIVE);
  const cases = [
    ['regular', 'set_policy', '^notification\\.events$', '{"dead-letter-exchange":"nawara.events.dlx"}', 'queues', '0', 'P1'],
    ['regular', 'set_policy', '.*', '{"message-ttl":60000}', 'all', '-5', 'P1'],
    ['regular', 'set_policy', '^notif', '{"max-length":10}', 'classic_queues', '100', 'P1'],
    ['regular', 'set_policy', 'events\\.dead$', '{"dead-letter-exchange":"x"}', 'queues', '7', 'P1'],
    ['operator', 'set_operator_policy', '^notification\\.events\\.retry$', '{"message-ttl":1000}', 'queues', '0', 'P2'],
    ['exchange', 'set_policy', '^nawara\\.events$', '{"alternate-exchange":"copy"}', 'exchanges', '0', 'P3'],
  ];
  for (const [kind, cmd, pattern, def, applyTo, prio, id] of cases) {
    const name = `odbrk2a-${randomBytes(3).toString('hex')}`;
    ctl(cmd, '-p', 'nawara-core', name, pattern, def, '--apply-to', applyTo, '--priority', prio);
    await withCleanup(() => {
      const v = verify('pre-grant');
      assert.equal(v.result, 'FAIL', `${kind} ${pattern} ${applyTo} ${prio}`);
      assert.equal(v.check(id).status, 'FAIL', `${kind} ${pattern}`);
      assert.notEqual(v.exit, 0);
    }, () => ctl(cmd === 'set_policy' ? 'clear_policy' : 'clear_operator_policy', '-p', 'nawara-core', name));
  }
  const quorum = 'odbrk2a-quorum';
  ctl('set_policy', '-p', 'nawara-core', quorum, '.*', '{"delivery-limit":3}', '--apply-to', 'quorum_queues');
  await withCleanup(() => {
    assert.equal(verify('pre-grant').check('P1').status, 'PASS', 'a quorum-only policy does not apply to the classic queues');
  }, () => ctl('clear_policy', '-p', 'nawara-core', quorum));
});

test('17: provisioning cannot pass while a policy applies (the gate, not only the verifier): refused, nothing granted', async () => {
  latch(INACTIVE);
  ctl('set_policy', '-p', 'nawara-core', 'odbrk2a-gate', '^notification\\.', '{"dead-letter-exchange":"nawara.events.dlx"}', '--apply-to', 'queues');
  await withCleanup(() => {
    const r = provision('notification-service');
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /"result":"FAIL"/);
    assert.equal(perms('notification-service'), undefined);
  }, () => ctl('clear_policy', '-p', 'nawara-core', 'odbrk2a-gate'));
});

test('post-grant failure WITHDRAWS the grant this run made (the post-grant listing fails: UNKNOWN), never leaves Notification able to connect', () => {
  latch(INACTIVE);
  // a pass-through docker that fails the post-grant permission listing only (the pre-grant one runs first and passes)
  const bin = join(work, 'shim');
  mkdirSync(bin, { recursive: true });
  const count = join(work, 'shim-count');
  writeFileSync(count, '0');
  const realDocker = execFileSync('bash', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nif [[ " $* " == *" list_permissions "* ]]; then n=$(cat ${JSON.stringify(count)}); echo $((n + 1)) > ${JSON.stringify(count)}; [ "$n" -ge 1 ] && exit 1; fi\nexec ${JSON.stringify(realDocker)} "$@"\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const r = provision('notification-service', { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /the grant made by this run was withdrawn/);
  assert.equal(perms('notification-service'), undefined, 'no permission left');
  assert.equal(topic('notification-service'), undefined, 'no topic permission left');
});

// ------------------------------------------------------------------------------------------------ the grant (1, 4) and its topology

test('1, 4: with the latch inactive and a clean broker, pre-grant PASSES (queues not yet created: NOT certified), the EXACT isolated role is granted, post-grant PASSES', () => {
  latch(INACTIVE);
  const pre = verify('pre-grant');
  assert.equal(pre.result, 'PASS', JSON.stringify(pre.checks));
  assert.equal(pre.completeness, 'pre_creation');
  for (const id of ['Q1', 'Q2', 'Q3']) assert.equal(pre.check(id).status, 'NOT_APPLICABLE_PRE_CREATION', id);
  const r = provision('notification-service');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /consumption is NOT authorized until a post-declaration verification passes/);
  assert.deepEqual(perms('notification-service'), [ROLE.conf, ROLE.write, ROLE.conf]);
  assert.deepEqual(topic('notification-service'), ['nawara.events', GEN['notification-service'].write.regex, GEN['notification-service'].read.regex]);
  for (const s of ['audit-service', 'billing-service', 'auth-service']) assert.ok(perms(s), `${s} still provisioned`);
  // a re-run is idempotent on an EXACT existing grant
  assert.equal(provision('notification-service').code, 0);
});

test('9: Notification\'s identity cannot publish into the shared fanout (403), and its private dead queue is never bound to it', async () => {
  const admin = await connect(adminUrl());
  const ch = await admin.createChannel();
  await ch.assertExchange('nawara.events.dlx', 'fanout', { durable: true }); // Audit declares it in production
  const c = await connect(urlOf('notification-service'));
  const errors = [];
  c.on('error', (e) => errors.push(String(e.message)));
  const cc = await c.createConfirmChannel();
  cc.on('error', (e) => errors.push(String(e.message)));
  cc.publish('nawara.events.dlx', '', Buffer.from('{"synthetic":true}'), { messageId: randomUUID() });
  await cc.waitForConfirms().catch((e) => errors.push(String(e.message)));
  await c.close().catch(() => {});
  assert.match(errors.join(' '), /403|ACCESS_REFUSED/);
});

test('post-grant on the LIVE topology (a real Notification declared its queues): PASS with completeness full; the retry queue\'s return routing is accepted', async () => {
  await startNotification();
  const v = verify('post-grant');
  assert.equal(v.result, 'PASS', JSON.stringify(v.checks));
  assert.equal(v.completeness, 'full');
  for (const id of ['Q1', 'Q2', 'Q3', 'B1', 'C1', 'U1']) assert.equal(v.check(id).status, 'PASS', id);
  const queues = ctl('list_queues', '-p', 'nawara-core', 'name', 'arguments', '--no-table-headers');
  assert.match(queues, /^notification\.events\t\[\]$/m);
  // 3.13.7 prints the empty default exchange as `[]` in text; the typed listing (what the verifier compares) says longstr ""
  assert.match(queues, /^notification\.events\.retry\t\[\{"x-dead-letter-exchange",\[\]\},\{"x-dead-letter-routing-key","notification\.events"\}\]$/m);
  assert.ok(ctl('list_queues', '-p', 'nawara-core', 'name', 'arguments', '--formatter', 'json').split('\n').includes(',{"name":"notification.events.retry","arguments":[["x-dead-letter-exchange","longstr",""],["x-dead-letter-routing-key","longstr","notification.events"]]}'));
  // a retry copy (a message with its own expiry) waiting in the retry queue is the kit's legitimate path, never a failure
  const admin = await connect(adminUrl());
  const ch = await admin.createChannel();
  ch.sendToQueue(`${Q}.retry`, Buffer.from('{"synthetic":true}'), { messageId: randomUUID(), expiration: '60000' });
  await sleep(300);
  assert.equal(verify('post-grant').result, 'PASS');
  await ch.purgeQueue(`${Q}.retry`);
});

test('5, 7, 8: excess privilege, an unsafe dead-letter route or an unexpected dead-queue binding FAILS post-grant', async () => {
  const restore = () => ctl('set_permissions', '-p', 'nawara-core', 'notification-service', ROLE.conf, ROLE.write, ROLE.conf);
  ctl('set_permissions', '-p', 'nawara-core', 'notification-service', ROLE.conf.replace('nawara\\.events|', 'nawara\\.events|nawara\\.events\\.dlx|'), ROLE.write, ROLE.conf);
  assert.equal(verify('post-grant').check('U1').status, 'FAIL', 'excess privilege');
  restore();
  ctl('set_user_tags', 'notification-service', 'management');
  assert.equal(verify('post-grant').check('U1').status, 'FAIL', 'a tag');
  ctl('set_user_tags', 'notification-service');
  ctl('set_permissions', '-p', 'nawara-core', 'audit-service', '^(audit-service\\.audit.*|notification\\.events)$', '^$', '^(notification\\.events)$');
  assert.equal(verify('post-grant').check('U2').status, 'FAIL', 'another identity reaching the Notification queue');
  provision('audit-service'); // converge Audit back to its own role
  assert.equal(verify('post-grant').result, 'PASS');
});

test('8: a binding of the private dead queue to the shared fanout FAILS (B1)', async () => {
  const admin = await connect(adminUrl());
  const ch = await admin.createChannel();
  await ch.bindQueue(`${Q}.dead`, 'nawara.events.dlx', '');
  await withCleanup(() => {
    assert.equal(verify('post-grant').check('B1').status, 'FAIL');
  }, () => ch.unbindQueue(`${Q}.dead`, 'nawara.events.dlx', ''));
  assert.equal(verify('post-grant').result, 'PASS');
});

test('drift: a REGULAR policy applied to the LIVE queues after the grant FAILS post-grant (the policy list and the effective policy)', async () => {
  const name = `odbrk2a-drift-${randomBytes(3).toString('hex')}`;
  ctl('set_policy', '-p', 'nawara-core', name, '^notification\\.events$', '{"dead-letter-exchange":"nawara.events.dlx"}', '--apply-to', 'queues');
  await withCleanup(async () => {
    await waitFor(() => ctl('list_queues', '-p', 'nawara-core', 'name', 'policy', '--no-table-headers').split('\n').includes(`${Q}\t${name}`), 30_000, 'the policy is effective');
    const v = verify('post-grant');
    assert.equal(v.result, 'FAIL');
    assert.equal(v.check('P1').status, 'FAIL');
    assert.equal(v.check('Q1').status, 'FAIL', 'the effective policy on the work queue');
  }, () => ctl('clear_policy', '-p', 'nawara-core', name));
  await waitFor(() => verify('post-grant').result === 'PASS', 30_000, 'PASS once the drift is cleared');
});

test('UNKNOWN never passes on the live broker with a valid latch: an unparseable typed queue listing is UNKNOWN; the gate never PASSes, refuses and changes nothing', () => {
  latch(INACTIVE);
  // a pass-through docker that garbles only the typed queue listing
  const bin = join(work, 'shim-json');
  mkdirSync(bin, { recursive: true });
  const realDocker = execFileSync('bash', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nif [[ " $* " == *" list_queues "* && " $* " == *" --formatter json "* ]]; then echo '[{"name":'; exit 0; fi\nexec ${JSON.stringify(realDocker)} "$@"\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const PATH = `${bin}:${process.env.PATH}`;
  const v = verify('post-grant', { PATH });
  assert.equal(v.check('L1').status, 'PASS', 'the latch itself is valid');
  for (const id of ['Q1', 'Q2', 'Q3']) assert.equal(v.check(id).status, 'UNKNOWN', id);
  assert.equal(v.result, 'UNKNOWN');
  assert.equal(v.exit, 3);
  // The gate, on the EXISTING exact grant with Notification live: the aggregate is never PASS. It is UNKNOWN, or FAIL when another check
  // independently establishes a violation (here C1: a live consumer before a pre-grant run); FAIL outranks UNKNOWN, by design.
  const users = () => ctl('list_users', '--no-table-headers').split('\n').find((l) => l.startsWith('notification-service\t'));
  const connections = () => ctl('list_connections', 'user', '--no-table-headers').split('\n').filter((u) => u === 'notification-service').length;
  const clientFile = () => readFileSync(join(env.BROKER_DIR, 'clients', 'notification-service.env'), 'utf8');
  const before = { perms: perms('notification-service'), topic: topic('notification-service'), user: users(), connections: connections(), file: clientFile() };
  assert.ok(before.perms && before.connections > 0, 'the grant is active and Notification is connected');
  const r = provision('notification-service', { PATH });
  assert.notEqual(r.code, 0, r.out);
  const gate = r.out.match(/topology pre-grant notification-service: (\{.*\})$/m);
  assert.ok(gate, r.out);
  const g = JSON.parse(gate[1]);
  assert.notEqual(g.result, 'PASS');
  assert.ok(['UNKNOWN', 'FAIL'].includes(g.result), g.result);
  for (const id of ['Q1', 'Q2', 'Q3']) assert.equal(g.checks.find((c) => c.id === id).status, 'UNKNOWN', `gate ${id}: the fault is still UNKNOWN`);
  if (g.result === 'FAIL') assert.ok(g.checks.some((c) => c.status === 'FAIL' && !['Q1', 'Q2', 'Q3'].includes(c.id)), 'FAIL only from an independently established violation');
  assert.doesNotMatch(r.out, /"result":"PASS"/);
  assert.match(r.out, /notification-service NOT provisioned: the pre-grant topology verification did not pass/);
  // no mutation: the active grant is neither revoked nor re-applied, the password and tags untouched, the live consumer not disconnected
  assert.deepEqual(perms('notification-service'), before.perms, 'permissions unchanged');
  assert.deepEqual(topic('notification-service'), before.topic, 'topic grant unchanged');
  assert.equal(users(), before.user, 'user and tags unchanged');
  assert.equal(clientFile(), before.file, 'client credential file unchanged');
  assert.equal(connections(), before.connections, 'Notification still connected (nothing closed)');
  // the fault removed (the shim is no longer on PATH): the real listings verify normally again
  assert.equal(verify('post-grant').result, 'PASS', 'and the real listing still passes');
});

// ------------------------------------------------------------------------------------------------ privacy on the provisioned broker (10-15)

test('14, 15, 12: an authenticated Auth event is taken once; a forged one is refused before intake, its dead letter redacted', async () => {
  const auth = new kit.RabbitMqEventBus({ url: urlOf('auth-service'), exchange: 'nawara.events' });
  open.push(auth);
  const e = envelope();
  await auth.publish(e);
  await auth.publish(e);
  await waitFor(async () => (await sql('SELECT count(*)::int AS n FROM notification WHERE "sourceEventId" = $1', [e.id]))[0].n === 1);
  await sleep(1500);
  assert.equal((await sql('SELECT count(*)::int AS n FROM notification WHERE "sourceEventId" = $1', [e.id]))[0].n, 1);
  const admin = await connect(adminUrl());
  const ch = await admin.createConfirmChannel();
  const f = envelope({ userId: 'attacker' });
  ch.publish('nawara.events', f.name, Buffer.from(JSON.stringify(f.payload)), { messageId: f.id, type: f.name, headers: f.headers, persistent: true });
  await ch.waitForConfirms();
  let dead;
  await waitFor(async () => !!(dead = await ch.get(`${Q}.dead`, { noAck: true })));
  assert.equal(dead.properties.headers['x-nawara-failure-reason'], 'untrusted_unverified_original');
  assert.equal(dead.properties.headers['x-nawara-body-redacted'], 'true');
  assert.ok(!dead.content.toString('latin1').includes(CODE), 'no code in the dead letter');
  assert.equal((await sql('SELECT count(*)::int AS n FROM notification WHERE "sourceEventId" = $1', [f.id]))[0].n, 0);
});

test('10, 11: on the provisioned broker a broker reject or a publisher expiry of a GENUINE code event leaves it in NO queue', async () => {
  await stopNotification();
  const auth = new kit.RabbitMqEventBus({ url: urlOf('auth-service'), exchange: 'nawara.events' });
  open.push(auth);
  const admin = await connect(adminUrl());
  const ch = await admin.createChannel();
  const e = envelope();
  await auth.publish(e);
  await waitFor(() => /^notification\.events\t1$/m.test(ctl('list_queues', '-p', 'nawara-core', 'name', 'messages', '--no-table-headers')));
  const before = vhostMessages(); // the genuine message, ready in the work queue, is counted here
  let m = false;
  await waitFor(async () => !!(m = await ch.get(Q, { noAck: false })));
  assert.equal(m.properties.userId, 'auth-service');
  ch.reject(m, false);
  await sleep(800);
  assert.equal(vhostMessages(), before - 1, 'discarded: it is in no queue at all');
  const baseline = vhostMessages();
  const x = envelope();
  const cc = await admin.createConfirmChannel();
  cc.publish('nawara.events', x.name, Buffer.from(JSON.stringify(x.payload)), { messageId: x.id, type: x.name, headers: x.headers, expiration: '50' });
  await cc.waitForConfirms();
  await sleep(800);
  assert.equal(vhostMessages(), baseline, 'expired: in no queue');
  for (const q of ctl('list_queues', '-p', 'nawara-core', 'name', '--no-table-headers').split('\n').filter((n) => n.endsWith('.dead'))) {
    for (;;) {
      const d = await ch.get(q, { noAck: true });
      if (!d) break;
      assert.ok(!d.content.toString('latin1').includes(CODE), `${q} keeps no code`);
    }
  }
});

// ------------------------------------------------------------------------------------------------ existing topology and other consumers (16, 18)

test('18: Billing and Audit keep their unchanged consumer roles (the shared fanout included) and their generated topic grants', () => {
  const legacy = (q) => {
    const e = q.replaceAll('.', '\\.');
    return [`^(nawara\\.events|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$`, `^(amq\\.default|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$`, `^(nawara\\.events|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$`];
  };
  assert.deepEqual(perms('audit-service'), legacy('audit-service.audit'));
  const billing = legacy('billing.payment-events');
  billing[1] = billing[1].replace('^(amq\\.default|', '^(amq\\.default|nawara\\.events|');
  assert.deepEqual(perms('billing-service'), billing);
  for (const s of ['audit-service', 'billing-service']) assert.deepEqual(topic(s), ['nawara.events', GEN[s].write.regex, GEN[s].read.regex], s);
});

test('16: an OLD-topology work queue (a broker dead-letter exchange) FAILS the verifier, a pre-grant run refuses, and its messages are kept', async () => {
  const admin = await connect(adminUrl());
  const ch = await admin.createChannel();
  for (const q of [Q, `${Q}.retry`, `${Q}.dead`]) await ch.deleteQueue(q);
  await ch.assertQueue(Q, { durable: true, arguments: { 'x-dead-letter-exchange': 'nawara.events.dlx' } });
  await ch.assertQueue(`${Q}.retry`, { durable: true, arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': Q } });
  await ch.assertQueue(`${Q}.dead`, { durable: true });
  ch.sendToQueue(Q, Buffer.from('{"kept":true}'));
  await sleep(300);
  const v = verify('post-grant');
  assert.equal(v.result, 'FAIL');
  assert.equal(v.check('Q1').status, 'FAIL');
  assert.match(ctl('list_queues', '-p', 'nawara-core', 'name', 'messages', '--no-table-headers'), /^notification\.events\t1$/m);
});

// Core V2 S1e-5 (ADR-0057 S0-C6): integrated certification of the ENFORCED consumers (Billing, Audit, Notification) against a broker
// provisioned by the AUTHENTIC infra/rabbitmq/provision.sh, against a LOCAL Docker daemon only:
//   npm run test:deploy:real-broker            (needs Docker on Linux; builds the services it runs)
//
// One isolated broker (container, network, volume and state dir prefixed `rbcons-<pid>`) and one PostgreSQL 16 container
// (`rbcons-<pid>-pg`, a loopback port Docker assigns), removed at the end by the exact names and ids this run created; nothing else is
// touched, and a pre-existing resource of any of those names makes the run refuse to start. The broker runs a TEST-ONLY variant of the
// script: the real script with only its generated block re-rendered by the real renderer for Auth's domain events ACTIVE (the
// precondition of Notification's first activation); the production activation file is never changed. Every identity is provisioned,
// and its effective grants are read back from the broker and compared with the generator's output and the script's role permissions.
// The consumers themselves (the real built processes, under their own identities) are exercised by the vitest certification
// `test/e2e-real-broker/certification/s1e5-integrated-provenance.cert-spec.ts`, which this driver runs with the broker and database it
// created. Payloads, codes and keys are synthetic; secrets are never printed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LATCH_STATE, latchPath, removeTestLatch, writeTestLatch } from './lib/test-latch.mjs';
import { ACTIVATION_FILE, generateTopicPermissions, generatedBlockOf, renderProvisionTopicGrants } from '../lib/topic-permissions.mjs';

const root = resolve(import.meta.dirname, '../..');
const APPS = readdirSync(join(root, 'apps'));
const CONTRACTS = Object.fromEntries(APPS.filter((a) => existsSync(join(root, 'apps', a, 'contracts/events.json'))).map((a) => [a, readFileSync(join(root, 'apps', a, 'contracts/events.json'), 'utf8')]));
const CATALOG = readFileSync(join(root, 'libs/audit-contract/src/catalog.ts'), 'utf8');
const ACTIVATION = JSON.parse(readFileSync(join(root, ACTIVATION_FILE), 'utf8'));
// the TEST-ONLY activation profile: Auth's domain events active, nothing else changed (the file on disk is never written)
const TEST_ACTIVATION = { ...ACTIVATION, domainEvents: { ...ACTIVATION.domainEvents, 'auth-service': 'active' } };
const GEN = generateTopicPermissions({ contracts: CONTRACTS, auditCatalog: CATALOG, apps: APPS, activation: TEST_ACTIVATION }).identities;
const IDENTITIES = Object.keys(GEN).sort();
const CONSUMER_QUEUES = { 'audit-service': 'audit-service.audit', 'billing-service': 'billing.payment-events', 'notification-service': 'notification.events' };
const esc = (q) => q.replaceAll('.', '\\.');
const ROLE = (svc) => {
  const q = CONSUMER_QUEUES[svc];
  if (!q) return { conf: '^nawara\\.events$', write: '^nawara\\.events$', read: '^$' };
  const e = esc(q);
  // OD-BRK-2a: Notification holds the ISOLATED consumer role (no configure, write or read on the shared `nawara.events.dlx`)
  if (svc === 'notification-service') {
    return { conf: `^(nawara\\.events|${e}|${e}\\.retry|${e}\\.dead)$`, write: `^(amq\\.default|${e}|${e}\\.retry|${e}\\.dead)$`, read: `^(nawara\\.events|${e}|${e}\\.retry|${e}\\.dead)$` };
  }
  const write = svc === 'billing-service' ? `^(amq\\.default|nawara\\.events|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$` : `^(amq\\.default|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$`;
  return { conf: `^(nawara\\.events|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$`, write, read: `^(nawara\\.events|nawara\\.events\\.dlx|${e}|${e}\\.retry|${e}\\.dead)$` };
};

const run = `rbcons-${process.pid}`;
const variants = mkdtempSync(join(tmpdir(), `${run}-variants-`));
// Core V2 OD-BRK-2a/2b: Notification is provisioned only through its real topology gate, here with a TEST-ONLY, root-owned, inactive
// containment latch in the run's own directory (lib/test-latch.mjs), exactly as the topic-grant certification does
const latchDir = mkdtempSync(join(tmpdir(), `${run}-latch-`));
const env = {
  NOTIFICATION_CONTAINMENT_STATE: latchPath(latchDir),
  ...process.env,
  BROKER_DIR: mkdtempSync(join(tmpdir(), `${run}-state-`)),
  CORE_NETWORK: `${run}-internal`,
  RABBITMQ_CONTAINER: `${run}-rabbitmq`,
  RABBITMQ_VOLUME: `${run}-data`,
  RABBITMQ_SERVICES: IDENTITIES.join(' '),
};
const BROKER = env.RABBITMQ_CONTAINER;
const PG = `${run}-pg`;
const created = { containers: [], network: undefined, volume: undefined };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ctl = (...args) => docker('exec', '-u', 'rabbitmq', BROKER, 'rabbitmqctl', '-q', ...args);
const SCRIPT = join(root, 'infra/rabbitmq/provision.sh');
const variantScript = () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const current = generatedBlockOf(text);
  const block = renderProvisionTopicGrants(generateTopicPermissions({ contracts: CONTRACTS, auditCatalog: CATALOG, apps: APPS, activation: TEST_ACTIVATION }));
  const at = text.indexOf(current);
  const file = join(variants, 'auth-active.sh');
  writeFileSync(file, text.slice(0, at) + block + text.slice(at + current.length));
  return file;
};
const pgPassword = randomBytes(24).toString('hex');
let pgUrl;

before(async () => {
  for (const [kind, name] of [['container', BROKER], ['container', PG], ['network', env.CORE_NETWORK], ['volume', env.RABBITMQ_VOLUME]]) {
    assert.ok(spawnSync('docker', [kind, 'inspect', name]).status !== 0, `${kind} ${name} already exists: refusing to use it`);
  }
  writeTestLatch(latchDir, LATCH_STATE.inactive);
  const r = spawnSync('bash', [variantScript()], { env, encoding: 'utf8' });
  // record what the script created (by name, then by id) before asserting, so a failure still cleans up exactly these
  if (spawnSync('docker', ['container', 'inspect', BROKER]).status === 0) created.containers.push(docker('inspect', '-f', '{{.Id}}', BROKER).trim());
  if (spawnSync('docker', ['network', 'inspect', env.CORE_NETWORK]).status === 0) created.network = env.CORE_NETWORK;
  if (spawnSync('docker', ['volume', 'inspect', env.RABBITMQ_VOLUME]).status === 0) created.volume = env.RABBITMQ_VOLUME;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  created.containers.push(docker('run', '-d', '--name', PG, '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-p', '127.0.0.1::5432', 'postgres:16-alpine').trim());
  const port = docker('port', PG, '5432/tcp').trim().split('\n')[0].split(':').pop();
  pgUrl = `postgres://postgres:${pgPassword}@127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', PG, 'pg_isready', '-U', 'postgres']).status === 0) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
});

after(() => {
  for (const id of created.containers.reverse()) spawnSync('docker', ['rm', '-f', id]);
  if (created.volume) spawnSync('docker', ['volume', 'rm', created.volume]);
  if (created.network) spawnSync('docker', ['network', 'rm', created.network]);
  rmSync(env.BROKER_DIR, { recursive: true, force: true });
  rmSync(variants, { recursive: true, force: true });
  removeTestLatch(latchDir);
  rmSync(latchDir, { recursive: true, force: true });
  for (const id of created.containers) assert.notEqual(spawnSync('docker', ['container', 'inspect', id]).status, 0, `container ${id} was not removed`);
  if (created.volume) assert.notEqual(spawnSync('docker', ['volume', 'inspect', created.volume]).status, 0, 'the volume was not removed');
  if (created.network) assert.notEqual(spawnSync('docker', ['network', 'inspect', created.network]).status, 0, 'the network was not removed');
});

test('S1e-5 broker: every identity holds EXACTLY its generated topic grant (Auth active, test-only) and its role\'s resource permissions; no wildcard', () => {
  const users = ctl('list_users', '--no-table-headers').split('\n').map((l) => l.split('\t')[0]).filter(Boolean).sort();
  assert.deepEqual(users, [...IDENTITIES, 'nawara-admin'].sort());
  const topic = Object.fromEntries(ctl('list_topic_permissions', '-p', 'nawara-core', '--no-table-headers').split('\n').filter(Boolean).map((l) => {
    const [user, exchange, write, read] = l.split('\t');
    return [user, { exchange, write, read }];
  }));
  const perms = Object.fromEntries(ctl('list_permissions', '-p', 'nawara-core', '--no-table-headers').split('\n').filter(Boolean).map((l) => {
    const [user, conf, write, read] = l.split('\t');
    return [user, { conf, write, read }];
  }));
  for (const svc of IDENTITIES) {
    assert.deepEqual(topic[svc], { exchange: 'nawara.events', write: GEN[svc].write.regex, read: GEN[svc].read.regex }, `${svc} topic grant`);
    assert.deepEqual(perms[svc], ROLE(svc), `${svc} resource permissions`);
    for (const v of [...Object.values(topic[svc]), ...Object.values(perms[svc])]) {
      // no wildcard, and no bare `audit\.` prefix alternative (every audit action is spelled out)
      assert.ok(!v.includes('.*') && !/(\^|\(|\|)audit\\\.(\||\)|\$)/.test(v), `${svc}: no wildcard or audit-prefix shortcut (${v})`);
    }
  }
  // Auth's domain events are in its grant ONLY under the test activation profile
  assert.ok(GEN['auth-service'].write.keys.includes('member.contact_verification_requested'));
  assert.equal(ACTIVATION.domainEvents['auth-service'], 'inactive', 'the production activation file is unchanged');
});

test('S1e-5 consumers: the integrated certification of Billing, Audit and Notification passes on this broker and database', () => {
  const ip = docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${env.CORE_NETWORK}").IPAddress}}`, BROKER).trim();
  const r = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.config.cert.ts'], {
    cwd: join(root, 'test/e2e-real-broker'),
    env: { ...process.env, CI: 'true', S1E5_BROKER_DIR: env.BROKER_DIR, S1E5_BROKER_HOST: ip, S1E5_BROKER_CONTAINER: BROKER, TEST_DATABASE_ADMIN_URL: pgUrl },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 1_500_000,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  process.stdout.write(out.split('\n').filter((l) => /✓|×|↓|Test Files|Tests |FAIL|Error/.test(l)).join('\n') + '\n');
  for (const f of readdirSync(join(env.BROKER_DIR, 'clients'))) {
    const secret = readFileSync(join(env.BROKER_DIR, 'clients', f), 'utf8').match(/:([0-9a-f]{64})@/)[1];
    assert.ok(!out.includes(secret), 'no broker secret is printed');
  }
  assert.ok(!out.includes(pgPassword), 'the database password is never printed');
  assert.equal(r.status, 0, out.slice(-20_000));
});

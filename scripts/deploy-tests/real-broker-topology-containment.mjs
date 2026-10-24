// Core V2 OD-BRK-2b-1 (ADR-0057 §8 "OD-BRK-0" D2): real-infrastructure certification of Notification's topology monitor and emergency
// containment, against a LOCAL Docker daemon, a task-owned sshd and unprivileged user namespaces only:
//   npm run test:deploy:real-broker            (needs Docker on Linux, user namespaces, sshd, ssh-keygen and the built service-kit)
// OD-BRK-2b-R: recovery is SIGNED and incident-bound; the signing key is a DISPOSABLE test key created in the run's own directory.
//
// One isolated broker provisioned by the AUTHENTIC infra/rabbitmq/provision.sh through its real OD-BRK-2a gate, and the topology monitor
// installed by its AUTHENTIC installer, both as root of a user namespace (`unshare -r`: the files they create are root-owned as the
// verifier sees them). The installed scripts are the reviewed ones with only their locations (and the broker's name) re-pinned; the
// verifier is the real, pinned infra/rabbitmq/verify-topology.sh. A pass-through `docker` first on the monitor's pinned PATH is
// transparent, except where a test turns on one fault (an unreadable listing, a silent revocation, a silent connection close) and it
// records the latch's content at every revocation. A real AMQP consumer authenticated as notification-service holds unacknowledged
// messages. Every resource is prefixed `rbcontain-<pid>`, refused if it exists, recorded (RBCONTAIN_MANIFEST) and removed at the end.
// Payloads are synthetic: no code, credential or personal data is ever published or printed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { bounded, cleanupAll, exited, stopChild } from './lib/owned-process.mjs';
import { variant } from './lib/topology-monitor-world.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const kit = require(join(root, 'libs/service-kit/dist/index.js'));
const amqp = require('amqplib');

const SRC = join(root, 'infra/rabbitmq/topology-monitor');
const SERVICE = 'notification-service';
const Q = 'notification.events';
const NOTIFICATION_BINDINGS = JSON.parse(readFileSync(join(root, 'apps/notification-service/contracts/events.json'), 'utf8')).consumes.map((e) => e.name).sort();
const LATCH_INACTIVE = 'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive';
const LATCH_CONTAINED = 'nawara-core-topology-containment v1\nservice=notification-service\nstate=contained';
const IMAGE = 'rabbitmq:3.13.7-alpine@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc';
const run = `rbcontain-${process.pid}`;
const work = realpathSync(mkdtempSync(join(tmpdir(), `${run}-`)));
const D = {
  brokerDir: join(work, 'broker'), src: join(work, 'src'), install: join(work, 'libexec'), state: join(work, 'state'), latchDir: join(work, 'latch'),
  units: join(work, 'units'), shim: join(work, 'shim'), ctl: join(work, 'ctl'), keys: join(work, 'keys'), trust: join(work, 'trust'),
};
D.incidentFile = join(D.latchDir, 'notification-service.incident');
D.trusted = join(D.trust, 'recovery-allowed-signers');
D.latch = join(D.latchDir, 'notification-service.containment');
const env = {
  BROKER_DIR: D.brokerDir, CORE_NETWORK: `${run}-internal`, RABBITMQ_CONTAINER: `${run}-rabbitmq`, RABBITMQ_VOLUME: `${run}-data`, NOTIFICATION_CONTAINMENT_STATE: D.latch,
};
const BROKER = env.RABBITMQ_CONTAINER;
const created = { containers: [], network: undefined, volume: undefined, sshd: undefined };
const record = () => { if (process.env.RBCONTAIN_MANIFEST) writeFileSync(process.env.RBCONTAIN_MANIFEST, `${JSON.stringify({ pid: process.pid, run, work, ...created })}\n`); };
record();
const open = [];
const SYS_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const hostDocker = execFileSync('bash', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL' });
const ctl = (...args) => docker('exec', '-u', 'rabbitmq', BROKER, 'rabbitmqctl', '-q', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A command as root of a user namespace, with an empty environment but PATH, HOME and `extra`. */
const ns = (args, { input, extra = {}, timeout = 300_000 } = {}) => {
  const r = spawnSync('unshare', ['-r', 'env', '-i', `PATH=${SYS_PATH}`, `HOME=${work}`, ...Object.entries(extra).map(([k, v]) => `${k}=${v}`), ...args], { input, encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[driver] ${r.error.message}` : ''}` };
};
const monitor = () => ns([join(D.install, 'verify-and-contain.sh'), SERVICE]);
const monitorAsync = () => new Promise((res) => {
  const c = spawn('unshare', ['-r', 'env', '-i', `PATH=${SYS_PATH}`, `HOME=${work}`, join(D.install, 'verify-and-contain.sh'), SERVICE]);
  c.on('close', res);
});
const provision = (services) => ns(['bash', join(root, 'infra/rabbitmq/provision.sh')], { extra: { ...env, RABBITMQ_SERVICES: services } });
const nsWrite = (path, text, mode = '600') => assert.equal(ns(['sh', '-c', `printf '%s' "$0" > "$1" && chmod ${mode} "$1"`, text, path]).code, 0);
const fault = (mode) => writeFileSync(join(D.ctl, 'fault'), mode);
const ip = () => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${env.CORE_NETWORK}").IPAddress}}`, BROKER).trim();
const urlOf = (svc) => readFileSync(join(D.brokerDir, 'clients', `${svc}.env`), 'utf8').trim().replace('RABBITMQ_URL=', '').replace(`@${BROKER}:`, `@${ip()}:`);
const adminUrl = () => {
  const f = readFileSync(join(D.brokerDir, 'rabbitmq.env'), 'utf8');
  const get = (k) => f.match(new RegExp(`^${k}=(.*)$`, 'm'))[1];
  return `amqp://${get('RABBITMQ_DEFAULT_USER')}:${get('RABBITMQ_DEFAULT_PASS')}@${ip()}:5672/nawara-core`;
};
const connect = async (url) => { const c = await amqp.connect(url, { timeout: 10_000 }); c.on('error', () => {}); open.push(c); return c; };
const grants = () => ({
  perms: ctl('list_user_permissions', SERVICE, '--no-table-headers').trim(),
  topic: ctl('list_user_topic_permissions', SERVICE, '--no-table-headers').trim(),
  connections: ctl('list_connections', 'user', '--no-table-headers').split('\n').filter((u) => u === SERVICE).length,
});
const auditGrants = () => `${ctl('list_user_permissions', 'audit-service', '--no-table-headers')}|${ctl('list_user_topic_permissions', 'audit-service', '--no-table-headers')}`;
const queueCounts = () => Object.fromEntries(ctl('list_queues', '-p', 'nawara-core', 'name', 'messages_ready', 'messages_unacknowledged', '--no-table-headers').split('\n').filter(Boolean).map((l) => l.split('\t')).map(([n, r, u]) => [n, { ready: Number(r), unacked: Number(u) }]));
const stateOf = () => {
  const m = /\ncontained=([01])\nincident=(none|[0-9a-f]{32})\nunknown_streak=(\d+)\nlast_result=(\w+)\n/.exec(readFileSync(join(D.state, 'state'), 'utf8'));
  return { contained: Number(m[1]), incident: m[2], streak: Number(m[3]), last: m[4] };
};
const records = (n) => (existsSync(join(D.state, n)) ? readFileSync(join(D.state, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const latchText = () => readFileSync(D.latch, 'utf8');
const writeState = (o) => nsWrite(join(D.state, 'state'), `nawara-core-topology-monitor-state v2\nservice=notification-service\ncontained=0\nincident=none\nunknown_streak=${o.streak ?? 0}\nlast_result=${o.last ?? 'PASS'}\nlast_run=${Math.floor(Date.now() / 1000)}\n`);
const until = async (cond, ms = 20_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await bounded(cond(), 10_000, what)) return; } catch { /* not yet */ } await sleep(200); }
  throw new Error(`${what}: not met within ${ms} ms`);
};

/** A live consumer authenticated as notification-service, holding every delivery unacknowledged. */
let consumer;
const attachConsumer = async () => {
  const c = await connect(urlOf(SERVICE));
  const ch = await c.createChannel();
  await ch.prefetch(20);
  const held = [];
  let closed = false;
  c.on('close', () => { closed = true; });
  await ch.consume(Q, (m) => { if (m) held.push(m); }, { noAck: false });
  consumer = { c, ch, held, closed: () => closed };
};
const publishSynthetic = async (n) => {
  const admin = await connect(adminUrl());
  const ch = await admin.createConfirmChannel();
  const ids = [];
  for (let i = 0; i < n; i += 1) { const id = randomUUID(); ids.push(id); ch.sendToQueue(Q, Buffer.from('{"synthetic":true}'), { persistent: true, messageId: id }); }
  await ch.waitForConfirms();
  await admin.close();
  return ids;
};
/**
 * An Owner authorization for `incident`, signed OFF the host with the DISPOSABLE test key (work/keys, never under the installation),
 * placed root-owned (0600) in the root-only inbox. The canonical text of recover-notification-topology.sh.
 */
const authorize = (incident, reason) => {
  const issued = Math.floor(Date.now() / 1000) - 5;
  const text = `nawara-core-topology-recovery-authorization v1\noperation=notification.topology_recovery\nservice=notification-service\nvhost=nawara-core\nincident=${incident}\nnonce=${randomBytes(16).toString('hex')}\nissued_at=${issued}\nnot_after=${issued + 900}\nreason=${reason}\n`;
  const draft = join(D.keys, 'authorization');
  rmSync(draft, { force: true });
  rmSync(`${draft}.sig`, { force: true });
  writeFileSync(draft, text, { mode: 0o600 });
  assert.equal(spawnSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', join(D.keys, 'owner'), '-n', 'nawara-core-topology-recovery', draft], { stdio: ['ignore', 'pipe', 'pipe'] }).status, 0);
  nsWrite(join(D.state, 'recovery', 'authorization'), text);
  nsWrite(join(D.state, 'recovery', 'authorization.sig'), readFileSync(`${draft}.sig`, 'utf8'));
};
const recover = () => ns([join(D.install, 'recover-notification-topology.sh')]);
/** The signed recovery of the CURRENT incident, then protected provisioning grants again through its own gates. */
const recoverAndRegrant = async (ref) => {
  const { incident } = stateOf();
  assert.match(incident, /^[0-9a-f]{32}$/);
  authorize(incident, ref);
  const r = recover();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /holds NO grant/);
  assert.equal(latchText(), LATCH_INACTIVE);
  assert.deepEqual(grants(), { perms: '', topic: '', connections: 0 }, 'recovery granted nothing and reopened nothing');
  const p = provision(SERVICE);
  assert.equal(p.code, 0, p.out);
  assert.match(p.out, /topology pre-grant notification-service: \{[^\n]*"result":"PASS"/);
  assert.match(p.out, /topology post-grant notification-service: \{[^\n]*"result":"PASS"/);
  await attachConsumer();
};

before(async () => {
  for (const [kind, name] of [['container', BROKER], ['network', env.CORE_NETWORK], ['volume', env.RABBITMQ_VOLUME]]) {
    assert.ok(spawnSync('docker', [kind, 'inspect', name], { timeout: 30_000 }).status !== 0, `${kind} ${name} already exists: refusing to use it`);
  }
  assert.equal(spawnSync('unshare', ['-r', 'true']).status, 0, 'unprivileged user namespaces are required');
  for (const d of [D.src, D.units, D.shim, D.ctl]) mkdirSync(d, { recursive: true });
  // the pass-through docker (transparent unless ctl/fault names one fault), recording the latch at every revocation
  writeFileSync(join(D.shim, 'docker'), [
    '#!/usr/bin/env bash',
    `mode=$(cat ${JSON.stringify(join(D.ctl, 'fault'))} 2>/dev/null || echo none)`,
    `case " $* " in *" clear_permissions "*|*" clear_topic_permissions "*) printf '%s\\n' "$(tail -n 1 ${JSON.stringify(D.latch)} 2>/dev/null)" >> ${JSON.stringify(join(D.ctl, 'latch-at-revoke'))} ;; esac`,
    'case "$mode" in',
    '  garble) if [[ " $* " == *" list_queues "* && " $* " == *" --formatter json "* ]]; then echo \'[{"name":\'; exit 0; fi ;;',
    '  silent-revoke) if [[ " $* " == *" clear_permissions "* || " $* " == *" clear_topic_permissions "* ]]; then exit 0; fi ;;',
    '  silent-close) if [[ " $* " == *" close_all_user_connections "* ]]; then exit 0; fi ;;',
    'esac',
    `exec ${JSON.stringify(hostDocker)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(D.shim, 'systemctl'), `#!/usr/bin/env bash\ncase "$1" in is-active) exit 0 ;; is-failed) exit 1 ;; *) exit 9 ;; esac\n`, { mode: 0o755 });
  fault('none');
  // the source tree the AUTHENTIC installer installs from: the reviewed scripts with only their locations and broker name re-pinned
  const tm = join(D.src, 'infra/rabbitmq/topology-monitor');
  mkdirSync(tm, { recursive: true });
  for (const f of readdirSync(SRC)) cpSync(join(SRC, f), join(tm, f));
  cpSync(join(root, 'infra/rabbitmq/verify-topology.sh'), join(D.src, 'infra/rabbitmq/verify-topology.sh'));
  const pins = { INSTALL_DIR: D.install, STATE_DIR: D.state, LATCH: D.latch, INCIDENT_FILE: D.incidentFile, TRUSTED_SIGNERS: D.trusted, BROKER, SAFE_PATH: `${D.shim}:${SYS_PATH}`, SYSTEMCTL: join(D.shim, 'systemctl'), UNIT_DIR: D.units };
  for (const f of ['verify-and-contain.sh', 'topology-watchdog.sh', 'recover-notification-topology.sh', 'install-topology-monitor.sh']) {
    const text = readFileSync(join(tm, f), 'utf8');
    writeFileSync(join(tm, f), variant(text, Object.fromEntries(Object.entries(pins).filter(([k]) => new RegExp(`^readonly ${k}=`, 'm').test(text)))), { mode: 0o755 });
  }
  // the DISPOSABLE test signing key (never a real Owner key); only its public half is trusted, root-owned, as a key-lifecycle step would
  mkdirSync(D.keys, { mode: 0o700 });
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'odbrk2b-r-disposable-owner', '-f', join(D.keys, 'owner')], { stdio: ['ignore', 'pipe', 'pipe'] }).status, 0);
  assert.equal(ns(['mkdir', '-m', '755', D.trust]).code, 0);
  nsWrite(D.trusted, `nawara-core-owner namespaces="nawara-core-topology-recovery" ${readFileSync(join(D.keys, 'owner.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')}\n`, '644');
  // 1. the installation (2b-2's order: install the control, its inactive latch, then provision)
  const inst = ns([join(tm, 'install-topology-monitor.sh')]);
  assert.equal(inst.code, 0, inst.out);
  assert.match(inst.out, /NOT enabled, NOT started/);
  // 2. the broker and the identities, through provision.sh's real gate for notification-service
  const p = provision('audit-service auth-service notification-service');
  if (spawnSync('docker', ['container', 'inspect', BROKER]).status === 0) created.containers.push(docker('inspect', '-f', '{{.Id}}', BROKER).trim());
  if (spawnSync('docker', ['network', 'inspect', env.CORE_NETWORK]).status === 0) created.network = env.CORE_NETWORK;
  if (spawnSync('docker', ['volume', 'inspect', env.RABBITMQ_VOLUME]).status === 0) created.volume = env.RABBITMQ_VOLUME;
  record();
  assert.equal(p.code, 0, p.out);
  assert.match(p.out, /topology pre-grant notification-service: \{[^\n]*"result":"PASS"/);
  // 3. Notification's isolated topology, declared as the service itself declares it, and a live consumer
  const bus = new kit.RabbitMqEventBus({ url: urlOf(SERVICE), connectTimeoutMs: 5000, confirmTimeoutMs: 5000, onNotice: () => {} });
  const sub = await bus.subscribe({ queue: Q, bindings: NOTIFICATION_BINDINGS, handler: async () => {}, brokerDeadLettering: kit.noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) });
  await sub.close();
  await bus.close();
  await attachConsumer();
}, { timeout: 420_000 });

after(async () => {
  const rm = (...args) => async () => {
    const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: ${r.error?.message ?? r.stderr.trim().slice(0, 200)}`);
  };
  await cleanupAll([
    ...(created.sshd ? [['stop the task sshd', async () => { await stopChild(created.sshd, { graceMs: 5000 }); }]] : []),
    ...[...open].reverse().map((x, i) => [`close connection ${i}`, () => x.close().catch((e) => { if (!/closed/i.test(String(e?.message))) throw e; })]),
    ...[...created.containers].reverse().map((id) => [`remove container ${id.slice(0, 12)}`, rm('rm', '-f', id)]),
    ...(created.volume ? [[`remove volume ${created.volume}`, rm('volume', 'rm', created.volume)]] : []),
    ...(created.network ? [[`remove network ${created.network}`, rm('network', 'rm', created.network)]] : []),
    ['remove the work directory', async () => rmSync(work, { recursive: true, force: true })],
    ['confirm every resource is gone', async () => {
      for (const id of created.containers) assert.ok(spawnSync('docker', ['container', 'inspect', id]).status !== 0, `container ${id} was not removed`);
      assert.ok(!existsSync(work), 'work directory not removed');
      if (created.sshd) assert.ok(exited(created.sshd), 'sshd still running');
    }],
  ], 90_000);
}, { timeout: 240_000 });

/** Every test is bounded on its own; the whole file by the command's --test-timeout (Node 22 applies it to each file too). */
const t = (name, fn) => test(name, { timeout: 240_000 }, fn);

// ------------------------------------------------------------------------------------------------ PASS and the UNKNOWN counter

t('1, 2: the safe LIVE topology is PASS (post-grant, the real verifier); a PASS resets the UNKNOWN counter and touches nothing', () => {
  const r = monitor();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /phase=post-grant result=PASS reason=verified/);
  writeState({ streak: 2, last: 'UNKNOWN' });
  assert.equal(monitor().code, 0);
  assert.deepEqual([stateOf().streak, stateOf().contained], [0, 0]);
  assert.equal(latchText(), LATCH_INACTIVE);
  assert.ok(grants().perms.includes('nawara-core'), 'the grant is untouched');
  assert.ok(!existsSync(join(D.ctl, 'latch-at-revoke')), 'no revocation ever ran');
});

// ------------------------------------------------------------------------------------------------ UNKNOWN x3 and the containment

t('4-6, 8-13: UNKNOWN #1 alerts, #2 escalates, #3 contains: latch first, grants revoked, connections closed, unacked messages kept, reconnection refused', async () => {
  const audit = auditGrants();
  const ids = await publishSynthetic(3);
  await until(() => consumer.held.length === 3, 20_000, 'the live consumer holds three deliveries');
  await until(() => queueCounts()[Q]?.unacked === 3, 20_000, 'three unacknowledged');
  fault('garble');
  let r = monitor();
  assert.equal(r.code, 10, r.out);
  assert.equal(records('alerts.jsonl').filter((a) => a.kind.startsWith('unknown_')).at(-1).kind, 'unknown_first');
  r = monitor();
  assert.equal(r.code, 10, r.out);
  assert.equal(records('alerts.jsonl').filter((a) => a.kind.startsWith('unknown_')).at(-1).severity, 'critical');
  assert.ok(grants().perms.includes('nawara-core'), 'nothing is contained before the third UNKNOWN');
  r = monitor();
  fault('none');
  assert.equal(r.code, 20, r.out);
  assert.match(r.out, /reason=unknown_3 .*containment=confirmed/);
  // 8: the latch said contained at every revocation
  const at = readFileSync(join(D.ctl, 'latch-at-revoke'), 'utf8').split('\n').filter(Boolean);
  assert.ok(at.length >= 2 && at.every((l) => l === 'state=contained'), `latch at revocation: ${at.join(',')}`);
  // 9, 13: two independent read-backs by this test, CONFIRM_INTERVAL apart
  assert.deepEqual(grants(), { perms: '', topic: '', connections: 0 });
  await sleep(5000);
  assert.deepEqual(grants(), { perms: '', topic: '', connections: 0 });
  // 10, 11: the live connection was closed by the broker; its unacked deliveries are back in the queue, nothing purged
  await until(() => consumer.closed(), 10_000, 'the consumer connection is closed');
  await until(() => queueCounts()[Q]?.ready === 3 && queueCounts()[Q]?.unacked === 0, 20_000, 'three messages ready again');
  const admin = await connect(adminUrl());
  const ch = await admin.createChannel();
  const back = await ch.get(Q, { noAck: false });
  assert.ok(back && back.fields.redelivered && ids.includes(back.properties.messageId), 'a returned (redelivered) original');
  ch.nack(back, false, true);
  // 12: reconnection is refused
  // the broker answers the connection's open with a close (no access to the vhost any more): amqplib reports it as such
  await assert.rejects(amqp.connect(urlOf(SERVICE), { timeout: 10_000 }), /Expected ConnectionOpenOk; got <ConnectionClose|ACCESS_REFUSED|NOT_ALLOWED|access to vhost/i);
  assert.equal(grants().connections, 0, 'and no connection of the service was established');
  assert.equal(latchText(), LATCH_CONTAINED);
  assert.equal(stateOf().contained, 1);
  assert.equal(auditGrants(), audit, 'Audit is unchanged');
  assert.ok(records('alerts.jsonl').some((a) => a.kind === 'contained' && a.severity === 'critical'));
});

t('17, 18: a PASS after containment restores nothing, and ordinary provisioning cannot regrant while contained', () => {
  const r = monitor();
  assert.equal(r.code, 20, r.out);
  assert.match(r.out, /mode=contained .*reason=containment_maintained/);
  const p = provision(SERVICE);
  assert.notEqual(p.code, 0, p.out);
  assert.match(p.out, /"id":"L1","status":"FAIL","reason":"latch_contained"/);
  assert.match(p.out, /notification-service NOT provisioned: the pre-grant topology verification did not pass/);
  assert.deepEqual(grants(), { perms: '', topic: '', connections: 0 });
  assert.equal(monitor().code, 20);
});

t('recovery: the guard clears the latch ONLY after a fresh verification; protected provisioning grants again through its gates', async () => {
  // refused while the topology is unsafe (a regular policy applies)
  ctl('set_policy', '-p', 'nawara-core', 'odbrk2b1-probe', '^notification\\.events$', '{"message-ttl":60000}', '--apply-to', 'queues');
  authorize(stateOf().incident, 'OD-RECOVERY-0');
  const refused = recover();
  ctl('clear_policy', '-p', 'nawara-core', 'odbrk2b1-probe');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /REFUSED \(topology_unsafe\)/);
  assert.equal(latchText(), LATCH_CONTAINED);
  assert.ok(!existsSync(join(D.state, 'recovery-consumed')), 'a refused recovery consumes nothing');
  const { incident } = stateOf();
  await recoverAndRegrant('OD-RECOVERY-1');
  const done = records('evidence.jsonl').filter((e) => e.kind === 'recovered').at(-1);
  assert.deepEqual([done.incident, done.reason], [incident, 'OD-RECOVERY-1']);
  assert.match(done.signer, /^SHA256:/);
  assert.equal(monitor().code, 0, 'the monitor resumes: PASS on the regranted live topology');
});

t('3, 7: a definitive FAIL (a regular policy re-opening a dead-letter route) contains at once and overrides a pending UNKNOWN', async () => {
  writeState({ streak: 1, last: 'UNKNOWN' });
  ctl('set_policy', '-p', 'nawara-core', 'odbrk2b1-drift', '^notification\\.events$', '{"dead-letter-exchange":"nawara.events.dlx"}', '--apply-to', 'queues');
  try {
    const r = monitor();
    assert.equal(r.code, 20, r.out);
    assert.match(r.out, /result=FAIL reason=verifier_fail checks=[A-Z0-9,]*P1/);
    assert.deepEqual(grants(), { perms: '', topic: '', connections: 0 });
  } finally {
    ctl('clear_policy', '-p', 'nawara-core', 'odbrk2b1-drift');
  }
  // a NEW incident: an authorization for the previous (recovered) incident is refused, and the latch stays contained
  const previous = records('evidence.jsonl').filter((e) => e.kind === 'recovered').at(-1).incident;
  assert.notEqual(stateOf().incident, previous);
  authorize(previous, 'OD-RECOVERY-STALE');
  const stale = recover();
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /REFUSED \(authorization_incident\)/);
  assert.equal(latchText(), LATCH_CONTAINED);
  await recoverAndRegrant('OD-RECOVERY-2');
});

// ------------------------------------------------------------------------------------------------ containment that cannot be confirmed

for (const [n, what, mode, left] of [
  ['14', 'a silent revocation failure (exit 0, the grant kept)', 'silent-revoke', (g) => g.perms !== ''],
  ['15, 16', 'a silent connection-close failure (grants revoked, the connection kept: partial)', 'silent-close', (g) => g.perms === '' && g.connections > 0],
]) {
  t(`${n}: ${what} is CONTAINMENT_UNCONFIRMED, never CONTAINED; the next run, without the fault, confirms`, async () => {
    fault(mode);
    ctl('set_policy', '-p', 'nawara-core', 'odbrk2b1-fail', '^notification\\.events$', '{"max-length":5}', '--apply-to', 'queues');
    let r;
    try {
      r = monitor();
    } finally {
      fault('none');
      ctl('clear_policy', '-p', 'nawara-core', 'odbrk2b1-fail');
    }
    assert.equal(r.code, 21, r.out);
    assert.match(r.out, /containment=unconfirmed attempts=3/);
    assert.ok(left(grants()), `the broker really still shows ${mode === 'silent-revoke' ? 'the grant' : 'the connection'}`);
    assert.ok(records('alerts.jsonl').some((a) => a.kind === 'containment_unconfirmed'));
    assert.equal(latchText(), LATCH_CONTAINED, 'the intent is persisted all the same');
    r = monitor();
    assert.equal(r.code, 20, r.out);
    assert.deepEqual(grants(), { perms: '', topic: '', connections: 0 });
    await recoverAndRegrant(`OD-RECOVERY-${mode.toUpperCase()}`);
  });
}

// ------------------------------------------------------------------------------------------------ concurrency, integrity, alerts, watchdog

t('19: three simultaneous runs are serialized: the counter counts each once, and only the third contains', async () => {
  fault('garble');
  let codes;
  try {
    codes = await Promise.all([monitorAsync(), monitorAsync(), monitorAsync()]);
  } finally {
    fault('none');
  }
  assert.deepEqual(codes.sort(), [10, 10, 20]);
  assert.deepEqual([stateOf().streak, stateOf().contained], [3, 1]);
  assert.deepEqual(grants(), { perms: '', topic: '', connections: 0 });
  await recoverAndRegrant('OD-RECOVERY-3');
});

t('20, 24: a corrupt state after installation contains (never re-initialized); an unwritable alert spool never blocks it', async () => {
  nsWrite(join(D.state, 'state'), 'garbage');
  assert.equal(ns(['sh', '-c', `rm -f "$0" && mkdir "$0"`, join(D.state, 'alerts.jsonl')]).code, 0);
  const r = monitor();
  assert.equal(r.code, 20, r.out);
  assert.match(r.out, /mode=integrity .*reason=state_corrupt .*containment=confirmed/);
  assert.match(r.out, /alert spool unavailable/);
  assert.deepEqual(grants(), { perms: '', topic: '', connections: 0 });
  assert.ok(existsSync(join(D.state, 'state.rejected')), 'the corrupt state is kept aside, not overwritten');
  assert.equal(ns(['rmdir', join(D.state, 'alerts.jsonl')]).code, 0);
  await recoverAndRegrant('OD-RECOVERY-4');
});

t('23: the watchdog on the real installation: ok while the monitor runs, overdue when it stops, killed when a run marker survives', () => {
  const wd = () => ns([join(D.install, 'topology-watchdog.sh')]);
  assert.equal(monitor().code, 0);
  let r = wd();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /status=ok/);
  nsWrite(join(D.state, 'state'), `nawara-core-topology-monitor-state v1\nservice=notification-service\ncontained=0\nunknown_streak=0\nlast_result=PASS\nlast_run=${Math.floor(Date.now() / 1000) - 3600}\n`);
  r = wd();
  assert.equal(r.code, 1);
  assert.match(r.out, /status=monitor_overdue/);
  nsWrite(join(D.state, 'running'), `started=${Math.floor(Date.now() / 1000)} pid=1`);
  assert.match(wd().out, /monitor_killed/);
  assert.equal(ns(['rm', '-f', join(D.state, 'running')]).code, 0);
  assert.equal(monitor().code, 0);
  assert.match(wd().out, /status=ok/);
  assert.ok(records('alerts.jsonl').some((a) => a.kind === 'watchdog_monitor_overdue'));
});

// ------------------------------------------------------------------------------------------------ installation verification, forced command

t('22: the read-only installation verification passes on the authentic installation, and fails an altered hash or a foreign owner', () => {
  // a second, UNMODIFIED installation (the reviewed files byte for byte), checked by the real verification script
  const A = { install: join(work, 'A-libexec'), state: join(work, 'A-state'), latchDir: join(work, 'A-latch'), units: join(work, 'A-units'), src: join(work, 'A-src') };
  A.latch = join(A.latchDir, 'notification-service.containment');
  mkdirSync(A.units);
  const tm = join(A.src, 'infra/rabbitmq/topology-monitor');
  mkdirSync(tm, { recursive: true });
  for (const f of readdirSync(SRC)) cpSync(join(SRC, f), join(tm, f));
  cpSync(join(root, 'infra/rabbitmq/verify-topology.sh'), join(A.src, 'infra/rabbitmq/verify-topology.sh'));
  const installer = join(tm, 'install-topology-monitor.sh');
  A.incidentFile = join(A.latchDir, 'notification-service.incident');
  writeFileSync(installer, variant(readFileSync(installer, 'utf8'), { INSTALL_DIR: A.install, STATE_DIR: A.state, LATCH: A.latch, INCIDENT_FILE: A.incidentFile, UNIT_DIR: A.units }));
  assert.equal(ns(['bash', installer]).code, 0);
  const checker = join(work, 'verify-install.sh');
  writeFileSync(checker, variant(readFileSync(join(SRC, 'verify-topology-monitor-install.sh'), 'utf8'), { INSTALL_DIR: A.install, STATE_DIR: A.state, LATCH: A.latch, INCIDENT_FILE: A.incidentFile, TRUSTED_SIGNERS: D.trusted, UNIT_DIR: A.units, TRUST_ROOT: work }), { mode: 0o755 });
  const check = () => ns(['bash', checker]);
  let r = check();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RESULT: PASS/);
  // an altered installed file
  const entry = join(A.install, 'verify-and-contain.sh');
  assert.equal(ns(['sh', '-c', `chmod 755 "$0" && printf '\\n# altered\\n' >> "$0" && chmod 555 "$0"`, entry]).code, 0);
  r = check();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL {2}sha256: .*verify-and-contain\.sh/);
  // a file owned by another user (the host's real root is not root inside the namespace: it shows as the overflow uid)
  assert.equal(ns(['rm', '-f', join(A.install, 'topology-trigger.sh')]).code, 0);
  docker('run', '--rm', '-v', `${A.install}:/w`, '--entrypoint', 'sh', IMAGE, '-c', 'printf x > /w/topology-trigger.sh && chmod 555 /w/topology-trigger.sh');
  r = check();
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL {2}mode: .*topology-trigger\.sh must be a file \(no symbolic link\) owned by 0:0/);
});

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

t('21: over a real sshd, the trigger key runs only the forced command: a client command, a subsystem and a remote forward are refused', async () => {
  const S = join(work, 'ssh');
  mkdirSync(S, { mode: 0o700 });
  // the trigger, installed (by this unprivileged user) where its pins say, owned by this user as its pinned owner
  const inst = join(S, 'libexec');
  mkdirSync(inst, { mode: 0o755 });
  const recorder = join(S, 'sudo');
  writeFileSync(recorder, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(S, 'sudo-calls'))}\n`, { mode: 0o755 });
  const entry = join(inst, 'topology-trigger.sh');
  writeFileSync(entry, variant(readFileSync(join(SRC, 'topology-trigger.sh'), 'utf8'), { INSTALL_DIR: inst, OWNER_UID: process.getuid(), SUDO: recorder }), { mode: 0o555 });
  for (const k of ['host', 'client']) assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `odbrk2b1-${k}`, '-f', join(S, k)]).status, 0);
  const template = readFileSync(join(SRC, 'topology-trigger.authorized_keys.template'), 'utf8').split('\n').find((l) => l.startsWith('restrict,'));
  writeFileSync(join(S, 'authorized_keys'), `${template.replace('/usr/local/libexec/nawara-core-topology/topology-trigger.sh', entry).replace(/ssh-ed25519 \S+/, readFileSync(join(S, 'client.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' '))}\n`, { mode: 0o600 });
  const port = await freePort();
  writeFileSync(join(S, 'sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(S, 'host')}`, `PidFile ${join(S, 'sshd.pid')}`, `AuthorizedKeysFile ${join(S, 'authorized_keys')}`,
    'UsePAM no', 'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'PermitUserEnvironment no',
    // as a production sshd declares it: with a forced command, a subsystem request runs the forced command (which refuses it)
    'Subsystem sftp internal-sftp', 'LogLevel ERROR', ''].join('\n'));
  created.sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(S, 'sshd_config')], { stdio: 'ignore' });
  record();
  const ssh = (...args) => spawnSync('ssh', ['-i', join(S, 'client'), '-p', String(port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=5', ...args], { encoding: 'utf8', timeout: 30_000 });
  await until(() => ssh('127.0.0.1').status === 0, 20_000, 'sshd accepts the trigger key');
  const calls = () => (existsSync(join(S, 'sudo-calls')) ? readFileSync(join(S, 'sudo-calls'), 'utf8').trim().split('\n') : []);
  assert.deepEqual(calls(), ['-n /usr/bin/systemctl start nawara-core-topology-monitor.service'], 'a plain session starts exactly the monitor unit, once');
  for (const args of [['127.0.0.1', 'id'], ['127.0.0.1', 'sh -c "touch /tmp/odbrk2b1-pwned"'], ['-s', '127.0.0.1', 'sftp'], ['127.0.0.1', '--', '--now']]) {
    const r = ssh(...args);
    assert.equal(r.status, 64, JSON.stringify(args));
    assert.doesNotMatch(r.stderr, /pwned|sftp/);
  }
  const fwd = ssh('-N', '-o', 'ExitOnForwardFailure=yes', '-R', '0:127.0.0.1:1', '127.0.0.1');
  assert.notEqual(fwd.status, 0, 'a remote forward is refused (restrict)');
  assert.deepEqual(calls().length, 1, 'no refused session started anything');
  assert.ok(!existsSync('/tmp/odbrk2b1-pwned'));
});

t('Billing and Audit roles are untouched, and Notification ends granted only through the gate (the run\'s final state)', () => {
  assert.match(ctl('list_user_permissions', 'audit-service', '--no-table-headers'), /nawara\\\.events\\\.dlx/, 'Audit keeps its legacy role (OD-BRK-4 is separate)');
  assert.equal(monitor().code, 0);
});

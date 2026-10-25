// Core V2 OD-BRK-2b-A: the topology monitor's EXTERNAL alert carrier (infra/rabbitmq/topology-monitor/topology-alert-carrier.sh) end to
// end, unprivileged, with the REAL producers (the monitor, the watchdog and the signed recovery of lib/topology-monitor-world.mjs, against
// its fake broker and stub verifier) writing the spool, the REAL carrier and the REAL curl delivering over TLS to a LOCAL HTTPS receiver
// that stands for Pushover and Healthchecks.io. Only the carrier's pins are re-pinned (`variant`): its locations, its uids, the two
// provider endpoints (to 127.0.0.1), the test CA and short budgets. Disposable credentials only; no real provider is ever called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, SRC, LATCH_CONTAINED, hex, world } from './lib/topology-monitor-world.mjs';
import { MANIFEST_ARTIFACTS, manifestText } from '../topology-monitor-manifest.mjs';
import { APPROVED_RUNBOOK, outgoingPrivacyViolations } from './lib/local-alert-receiver.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const SERVICE = 'notification-service';
const T0 = 1792800000;
const TOKEN = 'aT0kenForTestsOnly000000000001'; // 30 characters, disposable
const USER = 'uUserKeyForTestsOnly0000000001';
const HC_M = '11111111-1111-4111-8111-111111111111';
const HC_W = '22222222-2222-4222-8222-222222222222';
const CANARY = ['Bearer sk-live-CANARY', 'password=hunter2', 'RECOVERY-CODE-123456', '-----BEGIN OPENSSH PRIVATE KEY-----', 'erlang-cookie-CANARY', 'amqp://admin:secret@'];

// ------------------------------------------------------------------------------------------------ the TLS material and the receiver

const TLS = (() => {
  const d = mkdtempSync(join(tmpdir(), 'topology-alert-tls-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(d, 'key.pem'), '-out', join(d, 'cert.pem'),
    '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`openssl: ${r.stderr}`);
  process.on('exit', () => rmSync(d, { recursive: true, force: true }));
  return { dir: d, key: readFileSync(join(d, 'key.pem')), cert: readFileSync(join(d, 'cert.pem')), ca: join(d, 'cert.pem') };
})();

/** A local HTTPS server: POST /1/messages.json is "Pushover", GET /<uuid>/<exit status> is "Healthchecks.io". Plans are consumed in order. */
async function receiver() {
  const rx = { requests: [], pushover: [], hc: [], hcFor: {} };
  const next = (plan, fallback) => (plan.length > 1 ? plan.shift() : plan[0] ?? fallback);
  const server = createServer({ key: TLS.key, cert: TLS.cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      let r;
      if (req.method === 'POST' && url === '/1/messages.json') {
        const form = Object.fromEntries(new URLSearchParams(body));
        rx.requests.push({ kind: 'pushover', url, form, raw: body, headers: req.headers });
        r = next(rx.pushover, { status: 200, body: `{"status":1,"request":"${randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}"}` });
      } else {
        const m = /^\/([0-9a-f-]{36})\/(\d{1,3})$/.exec(url);
        rx.requests.push({ kind: 'hc', url, check: m?.[1] === HC_M ? 'monitor' : m?.[1] === HC_W ? 'watchdog' : 'unknown', status: m ? Number(m[2]) : null, method: req.method, raw: body, headers: req.headers });
        const plan = rx.hcFor[m?.[1]] ?? rx.hc;
        r = next(plan, { status: 200, body: 'OK' });
      }
      const send = () => { if (r.destroy) { req.socket.destroy(); return; } res.writeHead(r.status, { 'content-type': 'text/plain' }); res.end(r.body); };
      if (r.delay) setTimeout(send, r.delay); else send();
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  rx.port = server.address().port;
  rx.close = () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); });
  rx.pushes = () => rx.requests.filter((q) => q.kind === 'pushover');
  rx.pings = (check) => rx.requests.filter((q) => q.kind === 'hc' && (!check || q.check === check));
  return rx;
}

// ------------------------------------------------------------------------------------------------ the lab: producers, carrier, signed installation

const SCRIPTS = MANIFEST_ARTIFACTS.map(([n]) => n).filter((n) => n.endsWith('.sh') && n !== 'verify-topology.sh');
const UNITS = MANIFEST_ARTIFACTS.map(([n]) => n).filter((n) => /\.(service|timer)$/.test(n));

async function lab(opts = {}) {
  const rx = await receiver();
  try { return build(rx, opts); } catch (e) { await rx.close(); throw e; }
}
function build(rx, { carrierPins = {}, creds = true } = {}) {
  const w = world({ scripts: ['verify-and-contain.sh', 'recover-notification-topology.sh'] });
  const p = (...s) => join(w.base, ...s);
  w.rx = rx;
  w.carrierDir = p('carrier'); w.cred = p('cred'); w.units = p('units'); w.istate = p('istate'); w.itrustDir = p('itrust');
  w.itrust = join(w.itrustDir, 'install-allowed-signers');
  for (const [d, m] of [[w.carrierDir, 0o700], [w.cred, 0o700], [w.units, 0o755], [w.istate, 0o700], [w.itrustDir, 0o755]]) { mkdirSync(d); chmodSync(d, m); }
  // time: every producer and the carrier read `date +%s` from ctl/now (a `date -d` call is passed through)
  writeFileSync(join(w.shim, 'date'), `#!/usr/bin/env bash\nf=${JSON.stringify(join(w.ctl, 'now'))}\nif [ -f "$f" ]; then case " $* " in *" -d "*) ;; *) exec /usr/bin/date -d "@$(cat "$f")" "$@" ;; esac; fi\nexec /usr/bin/date "$@"\n`, { mode: 0o755 });
  // systemctl for the watchdog: the monitor's timer is active unless ctl/timer-inactive exists
  writeFileSync(join(w.shim, 'systemctl'), `#!/usr/bin/env bash\nif [ "$1" = is-active ]; then [ ! -f ${JSON.stringify(join(w.ctl, 'timer-inactive'))} ]; exit; fi\nif [ "$1" = is-failed ]; then exit 1; fi\nexit 0\n`, { mode: 0o755 });
  // docker and rabbitmqctl calls by the CARRIER would be recorded here (the producers' docker shim is the fake broker)
  w.now = T0; w.setNow = (t) => { w.now = t; writeFileSync(join(w.ctl, 'now'), `${t}\n`); };
  w.tick = (s) => w.setNow(w.now + s);
  w.setNow(T0);
  w.carrierPins = {
    CARRIER_DIR: w.carrierDir, CRED_DIR: w.cred, UNIT_DIR: w.units, INSTALL_STATE: w.istate, INSTALL_TRUST: w.itrust,
    PUSHOVER_URL: `https://127.0.0.1:${rx.port}/1/messages.json`,
    HC_URL_RE: `^https://127\\.0\\.0\\.1:${rx.port}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{22}/[a-z0-9_-]{1,100})$`,
    CA_FILE: TLS.ca, CURL_TIMEOUT: 2, HEARTBEAT_TIMEOUT: 2, ...carrierPins,
  };
  w.put('topology-watchdog.sh', { SYSTEMCTL: join(w.shim, 'systemctl') });
  for (const s of SCRIPTS.filter((n) => !['verify-and-contain.sh', 'recover-notification-topology.sh', 'topology-watchdog.sh'].includes(n))) w.put(s, w.carrierPins);
  for (const u of UNITS) { writeFileSync(join(w.units, u), readFileSync(join(SRC, u))); chmodSync(join(w.units, u), 0o644); }
  w.carrier = join(w.install, 'topology-alert-carrier.sh');
  w.seal = () => { // the Owner-signed installed record of exactly these files (a disposable key, the installation namespace)
    const k = w.key('install');
    writeFileSync(w.itrust, `nawara-core-owner namespaces="nawara-core-topology-install" ${readFileSync(`${k}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ')}\n`, { mode: 0o644 });
    const dest = (n) => (UNITS.includes(n) ? join(w.units, n) : join(w.install, n));
    const body = manifestText({ commit: 'a'.repeat(40), version: 1, hashes: Object.fromEntries(MANIFEST_ARTIFACTS.map(([n]) => [n, sha(readFileSync(dest(n)))])) });
    const inst = join(w.istate, 'installed'); rmSync(inst, { recursive: true, force: true }); mkdirSync(inst, { mode: 0o700 });
    writeFileSync(join(inst, 'manifest'), body, { mode: 0o600 });
    assert.equal(spawnSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', k, '-n', 'nawara-core-topology-install', join(inst, 'manifest')], { stdio: ['ignore', 'pipe', 'pipe'] }).status, 0);
    chmodSync(join(inst, 'manifest.sig'), 0o600);
  };
  w.seal();
  w.writeCreds = ({ token = TOKEN, user = USER, hcm = `https://127.0.0.1:${rx.port}/${HC_M}`, hcw = `https://127.0.0.1:${rx.port}/${HC_W}`, mode = 0o400 } = {}) => {
    for (const [f, v] of [['pushover.token', token], ['pushover.user', user], ['healthchecks-monitor.url', hcm], ['healthchecks-watchdog.url', hcw]]) {
      const path = join(w.cred, f); rmSync(path, { force: true });
      if (v !== null) { writeFileSync(path, `${v}\n`, { mode }); chmodSync(path, mode); }
    }
  };
  if (creds) w.writeCreds();
  w.run = () => new Promise((resolve) => {
    const c = spawn(w.carrier, [], { env: { PATH: '/usr/bin:/bin' } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 90_000);
    c.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, out }); });
    w.child = c;
  });
  w.monitor = () => spawnSync(join(w.install, 'verify-and-contain.sh'), [SERVICE], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60_000 });
  w.watchdog = () => spawnSync(join(w.install, 'topology-watchdog.sh'), [], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000 });
  w.recover = () => spawnSync(join(w.install, 'recover-notification-topology.sh'), [], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60_000 });
  w.spool = (line) => { const f = join(w.state, 'alerts.jsonl'); appendFileSync(f, `${line}\n`, { mode: 0o600 }); chmodSync(f, 0o600); };
  w.crecords = (name) => { const f = join(w.carrierDir, name); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
  w.queue = () => (existsSync(join(w.carrierDir, 'queue')) ? readdirSync(join(w.carrierDir, 'queue')).filter((f) => /^[0-2]-\d{12}-[0-9a-f]{16}\.json$/.test(f)) : []);
  w.queued = () => w.queue().map((f) => JSON.parse(readFileSync(join(w.carrierDir, 'queue', f), 'utf8')));
  w.lines = () => w.rx.pushes().flatMap((q) => q.form.message.split('\n'));
  w.codes = () => w.lines().map((l) => /^(CRITICAL|WARNING|INFO) ([a-z_]+)/.exec(l)?.[2]).filter(Boolean);
  return w;
}
const withLab = (opts, fn) => async () => {
  const w = await lab(opts);
  try { await fn(w); } finally { await w.rx.close(); w.cleanup(); }
};
/** A first carrier cycle (carrier_started delivered), with the receiver's records cleared. */
async function started(w) {
  const r = await w.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(w.codes(), ['carrier_started']);
  w.rx.requests.length = 0;
}
/** No canary, no credential, nothing but closed codes, numbers and ids reaches a provider or the journal. */
function noLeak(w, out = '') {
  const all = `${w.rx.requests.map((q) => `${q.url} ${q.form ? Object.entries(q.form).filter(([k]) => k !== 'token' && k !== 'user').map(([k, v]) => `${k}=${v}`).join('&') : q.raw}`).join('\n')}\n${out}`;
  for (const c of CANARY) assert.ok(!all.includes(c), `the canary ${c} leaked`);
  assert.ok(!out.includes(TOKEN) && !out.includes(USER) && !out.includes(HC_M) && !out.includes(HC_W), 'no credential in the journal');
  for (const q of w.rx.pushes()) {
    assert.deepEqual(Object.keys(q.form).sort(), ['message', 'priority', 'title', 'token', 'user']);
    assert.match(q.form.title, /^Nawara topology: [a-z_]+( \(\+\d+\))?$/);
    for (const l of q.form.message.split('\n')) assert.match(l, /^((CRITICAL|WARNING|INFO) [a-z_]+( reason=[a-z0-9_]+)?( problems=[a-z_,]+)?( incident=[0-9a-f]{32})?( x\d+)? at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ|OVERFLOW queue full: \d+ critical and \d+ other event\(s\) not queued individually; see alerts\.jsonl on the host|\+\d+ more queued|runbook=docs\/runbooks\/rabbitmq-topology-containment\.md)$/);
  }
  for (const q of w.rx.pings()) assert.equal(q.raw, '', 'a heartbeat carries no body');
  // the real-broker driver's outgoing-privacy check accepts every real message of the carrier (its runbook line included)
  assert.deepEqual(outgoingPrivacyViolations(w.rx.requests, { provider: { token: TOKEN, user: USER } }), []);
}
const MON = (kind, { at = T0, severity = 'critical', incident = 'none', reason, extra = '' } = {}) =>
  `{"v":1,"at":"${new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}","at_epoch":${at},"service":"notification-service","severity":"${severity}","kind":"${kind}","unknown_streak":0,"containment":"none","incident":"${incident}"${reason ? `,"reason":"${reason}"` : ''}${extra}}`;

// ------------------------------------------------------------------------------------------------ alert delivery

test('1, 5, 15: a real containment reaches the receiver: started, FAIL and confirmed, high priority, the incident id, nothing else', withLab({}, async (w) => {
  await started(w);
  // as on the host: a healthy monitor run and a watchdog check-in first (else the monitor reports watchdog_quiet, the watchdog an overdue run)
  w.setVerifier('PASS', 0); assert.equal(w.monitor().status, 0); assert.equal(w.watchdog().status, 0);
  w.tick(30); assert.equal((await w.run()).code, 0); w.rx.requests.length = 0;
  w.setVerifier('FAIL', 1, [['P1', 'FAIL', 'regular_policy_applies']]);
  assert.equal(w.monitor().status, 20);
  const incident = w.stateOf().incident;
  w.tick(30);
  const r = await w.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(w.codes(), ['containment_started', 'topology_verification_fail', 'containment_confirmed'], 'one message, critical events in their order');
  assert.equal(w.rx.pushes().length, 1);
  const q = w.rx.pushes()[0];
  assert.equal(q.form.priority, '1', 'the high-priority path');
  assert.equal(q.form.token, TOKEN); assert.equal(q.form.user, USER);
  assert.match(q.form.message, new RegExp(`CRITICAL containment_confirmed reason=verifier_fail incident=${incident}`));
  assert.equal(q.headers['content-type'], 'application/x-www-form-urlencoded');
  const d = w.crecords('deliveries.jsonl');
  assert.deepEqual(d.map((x) => x.outcome).slice(-2), ['submitted', 'accepted'], 'submission and confirmed acceptance are distinct records');
  assert.match(d.at(-1).request, /^[0-9a-f-]{36}$/);
  assert.deepEqual(w.queue(), []);
  noLeak(w, r.out);
}));

test('2, 3, 4, 15: malformed, oversized and unrecognized lines are refused as fixed alerts; their content never leaves the host', withLab({}, async (w) => {
  await started(w);
  w.spool(MON('contained', { incident: hex(), reason: 'verifier_fail' }).replace('}', `,"message":"${CANARY[0]}"}`)); // an extra field
  w.spool(`{"v":1,"note":"${CANARY[1]} ${CANARY[2]}"}`);
  w.spool(`not json at all ${CANARY[3]}`);
  w.spool(MON('contained', { reason: 'x'.repeat(30) }).replace('"reason":"', `"reason":"${'y'.repeat(1100)}`)); // over LINE_MAX
  w.spool(MON('grant_everything', { reason: 'verifier_fail' })); // well-formed, unknown kind
  w.spool(MON('contained', { severity: 'info', incident: hex(), reason: CANARY[4] })); // a reason outside the closed token set
  w.spool(MON('unknown_first', { severity: 'warning', reason: 'verifier_unknown' })); // a valid line among them
  const r = await w.run();
  assert.equal(r.code, 0, r.out);
  const rejected = w.lines().filter((l) => / spool_event_rejected /.test(l));
  assert.deepEqual(rejected.map((l) => /reason=(\w+)/.exec(l)[1]).sort(), ['malformed', 'oversized', 'unrecognized']);
  assert.match(w.lines().find((l) => l.includes('spool_event_rejected reason=malformed')), / x4 /, 'four malformed lines, one coalesced alert');
  assert.ok(w.codes().includes('topology_verification_unknown'), 'the valid line is still delivered');
  assert.deepEqual(w.crecords('events.jsonl').at(-1), { v: 1, at_epoch: T0, intake: 7, queued: 4, coalesced: 3, rejected: 6, overflowed: 0 });
  noLeak(w, r.out);
}));

test('6, 9: a provider timeout keeps the events durably queued; a later cycle, after the back-off, delivers them once', withLab({}, async (w) => {
  await started(w);
  w.spool(MON('contained', { incident: hex(), reason: 'verifier_fail' }));
  w.rx.pushover.push({ status: 200, body: '{"status":1}', delay: 4000 }, { status: 200, body: '{"status":1,"request":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}' });
  const r1 = await w.run();
  assert.equal(r1.code, 3, r1.out);
  assert.match(r1.out, /Pushover unreachable or failing \(HTTP 000, curl 28\): retrying in 60 s/);
  assert.equal(w.queue().length, 1);
  assert.equal(w.crecords('deliveries.jsonl').at(-1).outcome, 'retry');
  const r2 = await w.run(); // inside the back-off: nothing is attempted
  assert.equal(r2.code, 3); assert.match(r2.out, /backing off until/);
  assert.equal(w.rx.pushes().length, 1);
  w.tick(61);
  const r3 = await w.run();
  assert.equal(r3.code, 0, r3.out);
  assert.equal(w.rx.pushes().length, 2);
  assert.deepEqual(w.codes(), ['containment_confirmed', 'containment_confirmed'], 'the timed-out attempt and the delivery (at-least-once)');
  assert.deepEqual(w.queue(), []);
}));

test('7, 8: a temporary 5xx is retried with a growing back-off; a 4xx or 429 rejection is recorded and backs off an hour, never dropped', withLab({}, async (w) => {
  await started(w);
  w.spool(MON('containment_unconfirmed', { incident: hex(), reason: 'unknown_3' }));
  w.rx.pushover.push({ status: 503, body: 'no' }, { status: 502, body: 'no' }, { status: 400, body: '{"status":0,"errors":["user key is invalid"]}' }, { status: 429, body: '{}' }, { status: 200, body: '{"status":1,"request":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}' });
  assert.match((await w.run()).out, /HTTP 503, curl 0\): retrying in 60 s/);
  w.tick(61); assert.match((await w.run()).out, /HTTP 502, curl 0\): retrying in 120 s/);
  w.tick(121); const r = await w.run();
  assert.equal(r.code, 3); assert.match(r.out, /rejected the request \(HTTP 400; .*retrying in 3600 s/);
  assert.ok(!r.out.includes('user key is invalid'), "the provider's answer is never printed");
  assert.deepEqual(w.crecords('deliveries.jsonl').at(-1), { ...w.crecords('deliveries.jsonl').at(-1), outcome: 'rejected', http: '400' });
  assert.equal(w.queue().length, 1, 'kept');
  w.tick(1800); await w.run(); assert.equal(w.rx.pushes().length, 3, 'nothing during the hour');
  w.tick(1801); assert.match((await w.run()).out, /HTTP 429/);
  w.tick(3601); assert.equal((await w.run()).code, 0);
  assert.equal(w.rx.pushes().length, 5); assert.deepEqual(w.queue(), []);
}));

test('9: a cycle killed during delivery loses nothing: the next one resumes from the durable queue', withLab({}, async (w) => {
  await started(w);
  w.spool(MON('contained', { incident: hex(), reason: 'verifier_fail' }));
  w.rx.pushover.push({ status: 200, body: '{"status":1}', delay: 10_000 }, { status: 200, body: '{"status":1,"request":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}' });
  const running = w.run();
  for (let i = 0; i < 100 && w.rx.pushes().length === 0; i++) await new Promise((ok) => setTimeout(ok, 50));
  process.kill(w.child.pid, 'SIGKILL');
  assert.equal((await running).signal, 'SIGKILL');
  assert.equal(w.queue().length, 1, 'still queued after the kill');
  assert.equal(w.crecords('deliveries.jsonl').at(-1).outcome, 'submitted', 'submitted, never confirmed');
  const r = await w.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(w.queue(), []);
  assert.equal(w.crecords('deliveries.jsonl').at(-1).outcome, 'accepted');
}));

test('10: a storm of identical events is coalesced into ONE alert with a count; a replayed line is never re-sent', withLab({}, async (w) => {
  await started(w);
  const incident = hex();
  w.rx.pushover.push({ status: 503, body: '' }, { status: 200, body: '{"status":1,"request":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}' });
  for (let i = 0; i < 50; i++) w.spool(MON('containment_unconfirmed', { at: T0 + i, incident, reason: 'containment_maintained' }));
  assert.equal((await w.run()).code, 3);
  assert.equal(w.queue().length, 1);
  assert.equal(w.queued()[0].count, 50);
  w.tick(61);
  assert.equal((await w.run()).code, 0);
  assert.match(w.rx.pushes().at(-1).form.message, /CRITICAL containment_unconfirmed reason=containment_maintained incident=[0-9a-f]{32} x50 at=/);
  // the producer rewrites its bounded spool (same lines, a new file): nothing is delivered again
  const f = join(w.state, 'alerts.jsonl'); const text = readFileSync(f, 'utf8'); rmSync(f); writeFileSync(f, text, { mode: 0o600 });
  rmSync(join(w.carrierDir, 'cursor.line'));
  w.tick(60); const r = await w.run();
  assert.equal(w.rx.pushes().length, 3, 'only the spool_cursor_invalid alert');
  assert.deepEqual(w.codes().slice(-1), ['spool_cursor_invalid']);
  assert.equal(r.code, 0);
}));

test('11: a saturated queue is fail-visible: counted, reported in the next delivery, and escalated through the heartbeat', withLab({ carrierPins: { QUEUE_MAX: 3 } }, async (w) => {
  await started(w);
  w.rx.pushover.push({ status: 503, body: '' });
  for (const k of ['unknown_first', 'unknown_escalated', 'contained', 'containment_unconfirmed', 'latch_restored_by_monitor', 'incident_binding_restored']) w.spool(MON(k, { incident: hex(), reason: 'x' }));
  const r1 = await w.run();
  assert.match(r1.out, /queue saturated: 3 event\(s\) counted, not queued/);
  assert.equal(w.queue().length, 3);
  // the monitor PASSes meanwhile: its heartbeat is a FAILURE while critical events cannot be queued (never a healthy 0)
  w.setVerifier('PASS', 0); assert.equal(w.monitor().status, 0);
  w.rx.pushover.length = 0; w.rx.pushover.push({ status: 503, body: '' });
  w.tick(61); await w.run();
  assert.deepEqual(w.rx.pings('monitor').map((q) => q.status), [75]);
  w.rx.pushover.length = 0;
  w.tick(121); const r = await w.run();
  assert.equal(r.code, 0, r.out);
  assert.match(w.rx.pushes().at(-1).form.message, /OVERFLOW queue full: 3 critical and \d+ other event\(s\) not queued individually; see alerts\.jsonl on the host/);
  assert.equal(w.rx.pushes().at(-1).form.priority, '1');
  noLeak(w, r.out);
}));

test('12: a corrupt cursor or state fails visibly (set aside, critical alert), and what was delivered is not delivered again', withLab({}, async (w) => {
  await started(w);
  w.spool(MON('contained', { incident: hex(), reason: 'verifier_fail' }));
  w.tick(60); await w.run();
  assert.equal(w.rx.pushes().length, 1);
  writeFileSync(join(w.carrierDir, 'state'), 'nawara-core-topology-alert-state v1\ncursor_epoch=x\n', { mode: 0o600 });
  w.tick(60); const r = await w.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /state, cursor or ledger was invalid: set aside/);
  assert.ok(existsSync(join(w.carrierDir, 'state.rejected')));
  assert.deepEqual(w.codes(), ['containment_confirmed', 'spool_cursor_invalid'], 'the delivered event is deduplicated by the ledger');
  // a cursor that is a symbolic link is never followed
  rmSync(join(w.carrierDir, 'cursor.line')); symlinkSync(join(w.state, 'alerts.jsonl'), join(w.carrierDir, 'cursor.line'));
  w.tick(3600); await w.run();
  assert.deepEqual(w.codes().slice(-1), ['spool_cursor_invalid']);
}));

test('13: the Auth A5-R3 carrier\'s state and evidence stay untouched and independent', withLab({}, async (w) => {
  const auth = join(w.base, 'var-lib-nawara-auth-readiness-alert');
  mkdirSync(join(auth, 'queue'), { recursive: true });
  writeFileSync(join(auth, 'state'), 'state=ready\nseq=7\n'); writeFileSync(join(auth, 'queue', '000000000007-ALERT.json'), '{"kind":"ALERT"}\n');
  const before = spawnSync('sh', ['-c', `cd "$0" && find . -type f -exec sha256sum {} + | sort && stat -c '%n %a %Y' state queue/*`, auth], { encoding: 'utf8' }).stdout;
  await started(w);
  w.spool(MON('contained', { incident: hex(), reason: 'verifier_fail' })); w.tick(60); await w.run();
  assert.equal(spawnSync('sh', ['-c', `cd "$0" && find . -type f -exec sha256sum {} + | sort && stat -c '%n %a %Y' state queue/*`, auth], { encoding: 'utf8' }).stdout, before);
  const text = readFileSync(join(SRC, 'topology-alert-carrier.sh'), 'utf8');
  assert.ok(!/nawara-auth-readiness-alert/.test(text.replace(/^\s*#.*$/gm, '')), 'the carrier never names the Auth carrier');
  assert.ok(readFileSync(join(SRC, 'nawara-core-topology-alert.service'), 'utf8').includes('InaccessiblePaths=-/etc/nawara-auth-readiness-alert -/var/lib/nawara-auth-readiness-alert'));
  assert.notEqual(readFileSync(join(SRC, 'topology-alert-carrier.sh'), 'utf8').match(/^readonly CARRIER_DIR='(.*)'$/m)[1], '/var/lib/nawara-auth-readiness-alert');
}));

test('14: containment never depends on the carrier: stopped, broken, unwritable or hanging, the monitor contains on its own', withLab({}, async (w) => {
  // the carrier is not running at all and its directory is gone: the monitor contains exactly as before
  rmSync(w.carrierDir, { recursive: true, force: true });
  w.setVerifier('FAIL', 1, [['P1', 'FAIL', 'regular_policy_applies']]);
  const t = Date.now();
  const r = w.monitor();
  assert.equal(r.status, 20, r.stderr);
  assert.ok(Date.now() - t < 20_000);
  assert.equal(w.latchText(), LATCH_CONTAINED);
  assert.ok(w.records('alerts.jsonl').some((a) => a.kind === 'containment_started') && w.records('alerts.jsonl').some((a) => a.kind === 'contained'), 'the local evidence is complete');
  // the carrier starts later, against a provider that hangs: it delivers nothing yet, and a monitor run meanwhile is not slowed
  mkdirSync(w.carrierDir, { mode: 0o700 });
  w.rx.pushover.push({ status: 200, body: '{"status":1}', delay: 30_000 });
  const running = w.run();
  for (let i = 0; i < 100 && w.rx.pushes().length === 0; i++) await new Promise((ok) => setTimeout(ok, 50));
  const t2 = Date.now();
  assert.equal(w.monitor().status, 20, 'maintained while the carrier hangs');
  assert.ok(Date.now() - t2 < 20_000);
  process.kill(w.child.pid, 'SIGKILL'); await running;
  assert.ok(!readFileSync(join(SRC, 'verify-and-contain.sh'), 'utf8').replace(/^\s*#.*$/gm, '').match(/curl|topology-alert/));
}));

// ------------------------------------------------------------------------------------------------ heartbeats

test('16, 17, 18: each COMPLETED run, monitor and watchdog, is one success ping to its OWN check, once', withLab({}, async (w) => {
  await started(w);
  assert.deepEqual(w.rx.pings(), [], 'no run yet: no ping (never fabricated)');
  w.setVerifier('PASS', 0); assert.equal(w.monitor().status, 0);
  w.tick(10); assert.equal(w.watchdog().status, 0);
  w.tick(10); assert.equal((await w.run()).code, 0);
  assert.deepEqual(w.rx.pings().map((q) => [q.check, q.status, q.method]).sort(), [['monitor', 0, 'GET'], ['watchdog', 0, 'GET']]);
  w.tick(60); await w.run();
  assert.equal(w.rx.pings().length, 2, 'no new run, no new ping');
  w.tick(240); w.monitor(); w.tick(60); await w.run();
  assert.equal(w.rx.pings('monitor').length, 2); assert.equal(w.rx.pings('watchdog').length, 1, 'the monitor never pings for the watchdog');
  const hb = w.crecords('heartbeats.jsonl');
  assert.deepEqual(hb.map((h) => `${h.check}:${h.outcome}:${h.status}`), ['monitor:sent:0', 'watchdog:sent:0', 'monitor:sent:0']);
  noLeak(w);
}));

test('19: UNKNOWN, contained, unconfirmed and a watchdog problem are failure pings, never a healthy PASS', withLab({}, async (w) => {
  await started(w);
  const step = async (prepare, expect) => { w.tick(300); prepare(); w.tick(5); await w.run(); assert.deepEqual(w.rx.pings('monitor').map((q) => q.status).slice(-1), [expect]); };
  await step(() => { w.setVerifier('UNKNOWN', 3); assert.equal(w.monitor().status, 10); }, 10);
  await step(() => { w.setVerifier('FAIL', 1, [['P1', 'FAIL', 'regular_policy_applies']]); assert.equal(w.monitor().status, 20); }, 20);
  await step(() => { w.patchBroker((b) => { b.silentClose = true; b.connections.push(SERVICE); }); assert.equal(w.monitor().status, 21); }, 21);
  assert.ok(!w.rx.pings('monitor').some((q) => q.status === 0));
  writeFileSync(join(w.ctl, 'timer-inactive'), '');
  w.tick(5); assert.equal(w.watchdog().status, 1); w.tick(5); await w.run();
  assert.deepEqual(w.rx.pings('watchdog').map((q) => q.status), [1]);
  assert.ok(w.codes().includes('monitor_timer_inactive'), 'and the watchdog\'s finding is an alert');
}));

test('20, 21, 24: a dead monitor and a dead watchdog each stop ONLY their own pings; a gap past the window is recorded locally', withLab({}, async (w) => {
  await started(w);
  w.setVerifier('PASS', 0);
  // five healthy periods: the gaps between successful pings stay far inside the 15-minute window (5-minute period + 10-minute grace)
  const at = { monitor: [], watchdog: [] };
  for (let i = 0; i < 5; i++) {
    w.monitor(); w.tick(150); w.watchdog();
    for (let c = 0; c < 3; c++) { w.tick(50); const n = w.rx.pings().length; await w.run(); for (const q of w.rx.pings().slice(n)) at[q.check].push(w.now); }
  }
  for (const k of ['monitor', 'watchdog']) {
    assert.equal(at[k].length, 5);
    assert.ok(at[k].slice(1).every((t, i) => t - at[k][i] <= 360), `${k}: at most period + one carrier cycle between pings`);
  }
  // the monitor dies; the watchdog keeps running (and reports it); the monitor check receives nothing more
  const lastMonitor = at.monitor.at(-1);
  for (let i = 0; i < 4; i++) { w.tick(250); w.watchdog(); w.tick(50); await w.run(); }
  assert.equal(w.rx.pings('monitor').length, 5, 'no ping without a new completed monitor run');
  assert.equal(w.rx.pings('watchdog').length, 9, 'the watchdog check is independent');
  assert.ok(w.now - lastMonitor > 900);
  assert.ok(w.crecords('heartbeats.jsonl').some((h) => h.check === 'monitor' && h.outcome === 'missed'), 'the local evidence of the gap');
  assert.ok(w.codes().includes('monitor_overdue'), 'and the watchdog alerts through Pushover');
  // now the watchdog dies too, and a new monitor run arrives: only the monitor pings
  w.monitor(); w.tick(30); await w.run();
  assert.equal(w.rx.pings('monitor').length, 6);
  for (let i = 0; i < 4; i++) { w.tick(300); w.monitor(); w.tick(30); await w.run(); }
  assert.equal(w.rx.pings('watchdog').length, 9, 'no watchdog ping without a watchdog run');
  assert.ok(w.crecords('heartbeats.jsonl').some((h) => h.check === 'watchdog' && h.outcome === 'missed'));
  const src = readFileSync(join(SRC, 'topology-alert-carrier.sh'), 'utf8');
  assert.match(src, /^readonly HB_FRESH=360$/m); assert.match(src, /^readonly HB_WINDOW=900$/m);
  assert.match(readFileSync(join(SRC, 'nawara-core-topology-monitor.timer'), 'utf8'), /^OnUnitActiveSec=5min$/m);
  assert.match(readFileSync(join(SRC, 'nawara-core-topology-alert.timer'), 'utf8'), /^OnUnitActiveSec=60$/m);
}));

test('22, 23: a heartbeat outage is recorded and alerted; a late recovery pings only the latest FRESH run, never a missed one', withLab({}, async (w) => {
  await started(w);
  w.setVerifier('PASS', 0);
  w.rx.hcFor[HC_M] = [{ status: 500, body: 'down' }];
  w.monitor(); w.tick(20);
  const r = await w.run();
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /the monitor check-in failed \(HTTP 500, curl 0\)/);
  assert.ok(w.crecords('heartbeats.jsonl').some((h) => h.check === 'monitor' && h.outcome === 'failed'));
  assert.ok(w.codes().includes('heartbeat_delivery_failed'), 'the outage reaches the Owner through the other provider');
  // the outage lasts 20 minutes, the monitor keeps running: nothing reaches the check
  for (let i = 0; i < 4; i++) { w.tick(280); w.monitor(); w.tick(20); await w.run(); }
  const failed = w.rx.pings('monitor').length;
  // the provider is back, but the latest run is already older than HB_FRESH: it is NOT pinged (that would hide the gap)
  w.rx.hcFor[HC_M] = [{ status: 200, body: 'OK' }];
  w.tick(400); await w.run();
  assert.equal(w.rx.pings('monitor').length, failed, 'no ping for a stale run');
  assert.ok(w.crecords('heartbeats.jsonl').some((h) => h.outcome === 'stale_run_not_pinged'));
  // the next real run is pinged, once
  w.monitor(); w.tick(10); await w.run(); w.tick(60); await w.run();
  assert.deepEqual(w.rx.pings('monitor').slice(failed).map((q) => q.status), [0]);
  // "OK (not found)" and "OK (rate limited)" are not recorded pings
  w.rx.hcFor[HC_M] = [{ status: 200, body: 'OK (not found)' }];
  w.tick(300); w.monitor(); w.tick(10);
  const nf = await w.run();
  assert.equal(nf.code, 4, nf.out);
}));

// ------------------------------------------------------------------------------------------------ credentials, permissions, integrity

test('8, 31: weak, linked or malformed credentials are refused without printing them; the intake still records the events', withLab({}, async (w) => {
  w.writeCreds({ mode: 0o644 });
  w.spool(MON('contained', { incident: hex(), reason: 'verifier_fail' }));
  const r = await w.run();
  assert.equal(r.code, 78, r.out);
  assert.match(r.out, /Pushover token or user key is missing or invalid \(value not shown\)/);
  assert.deepEqual(w.rx.requests, [], 'nothing sent');
  assert.equal(w.queue().length, 2, 'carrier_started and the containment are durably queued');
  w.writeCreds({ token: 'short' }); assert.equal((await w.run()).code, 78);
  w.writeCreds(); rmSync(join(w.cred, 'pushover.user')); symlinkSync(join(w.base, 'elsewhere'), join(w.cred, 'pushover.user')); writeFileSync(join(w.base, 'elsewhere'), `${USER}\n`, { mode: 0o400 });
  assert.equal((await w.run()).code, 78);
  w.writeCreds({ hcw: `https://127.0.0.1:${w.rx.port}/${HC_M}` });
  assert.match((await w.run()).out, /two DIFFERENT checks/);
  w.writeCreds({ hcm: `http://127.0.0.1:${w.rx.port}/${HC_M}` }); assert.equal((await w.run()).code, 78, 'plain HTTP is never accepted');
  w.writeCreds();
  const ok = await w.run();
  assert.equal(ok.code, 0, ok.out);
  noLeak(w, `${r.out}${ok.out}`);
  // the carrier's own directory: never a symbolic link or weakly permissioned
  chmodSync(w.carrierDir, 0o755); assert.equal((await w.run()).code, 65); chmodSync(w.carrierDir, 0o700);
  renameSync(join(w.carrierDir, 'queue'), join(w.base, 'q')); symlinkSync(join(w.base, 'q'), join(w.carrierDir, 'queue'));
  assert.equal((await w.run()).code, 65);
}));

test('28, 31: the carrier never runs docker or rabbitmqctl, never writes the producers\' directory and refuses an unsafe spool', withLab({}, async (w) => {
  const calls = join(w.ctl, 'carrier-docker-calls');
  // the producers' docker is the fake broker; a carrier docker call would be recorded by it
  await started(w);
  w.setVerifier('FAIL', 1, [['P1', 'FAIL', 'regular_policy_applies']]); w.monitor();
  const brokerCalls = w.broker().calls.length;
  const before = spawnSync('sh', ['-c', `cd "$0" && find . -path ./lock -prune -o -type f -exec sha256sum {} + | sort`, w.state], { encoding: 'utf8' }).stdout;
  w.tick(30); await w.run();
  assert.equal(w.broker().calls.length, brokerCalls, 'the carrier made no broker call');
  assert.ok(!existsSync(calls));
  assert.equal(spawnSync('sh', ['-c', `cd "$0" && find . -path ./lock -prune -o -type f -exec sha256sum {} + | sort`, w.state], { encoding: 'utf8' }).stdout, before, 'the producers\' files are unchanged');
  // a spool that is a symbolic link, or weakly permissioned, is never read
  const f = join(w.state, 'alerts.jsonl'); renameSync(f, join(w.base, 'other')); symlinkSync(join(w.base, 'other'), f);
  w.tick(3600); await w.run();
  assert.match(w.lines().at(-2) ?? '', /CRITICAL spool_unreadable reason=spool_unsafe/);
  rmSync(f); writeFileSync(f, `${MON('contained', { incident: hex() })}\n`, { mode: 0o644 }); chmodSync(f, 0o644);
  w.tick(3600); await w.run();
  assert.ok(w.lines().some((l) => /spool_unreadable reason=spool_unsafe/.test(l)));
  const unit = readFileSync(join(SRC, 'nawara-core-topology-alert.service'), 'utf8');
  for (const p of ['/run/docker.sock', '/var/run/docker.sock', '/run/containerd', '/var/lib/docker', '/opt/nawara-core', '/var/lib/nawara-core-topology-monitor/recovery']) assert.match(unit, new RegExp(`^InaccessiblePaths=.*-${p.replace(/[/.]/g, '\\$&')}( |$)`, 'm'));
  assert.doesNotMatch(unit, /^(ReadWritePaths|Environment|EnvironmentFile|User|SupplementaryGroups)=/m);
}));

test('26, 32: the integrity sentinel alerts on a changed artifact or an open transaction, and when it is restored', withLab({}, async (w) => {
  await started(w);
  const f = join(w.install, 'topology-watchdog.sh');
  chmodSync(f, 0o755); appendFileSync(f, '# tampered\n'); chmodSync(f, 0o555);
  w.tick(60); await w.run();
  assert.match(w.lines().at(-2), /^CRITICAL installation_integrity_failed reason=hash_mismatch at=/);
  w.tick(60); await w.run();
  assert.equal(w.rx.pushes().length, 1, 'a lasting condition is not re-sent every cycle');
  w.put('topology-watchdog.sh', { SYSTEMCTL: join(w.shim, 'systemctl') });
  w.tick(60); await w.run();
  assert.match(w.lines().at(-2), /^INFO installation_integrity_restored reason=ok at=/);
  mkdirSync(join(w.istate, 'transaction'));
  w.tick(60); await w.run();
  assert.match(w.lines().at(-2), /installation_integrity_failed reason=transaction_open/);
  rmSync(join(w.istate, 'transaction'), { recursive: true });
  const sig = join(w.istate, 'installed', 'manifest.sig'); chmodSync(sig, 0o600); writeFileSync(sig, readFileSync(sig, 'utf8').replace(/[A-Za-z]/, (c) => (c === 'A' ? 'B' : 'A')));
  w.tick(60); await w.run();
  assert.ok(w.lines().some((l) => / installation_integrity_failed reason=manifest_signature /.test(l)));
}));

// ------------------------------------------------------------------------------------------------ the producers' new events, end to end

test('the signed recovery\'s authorization, refusal and completion reach the Owner; the guard itself is unchanged in what it decides', withLab({}, async (w) => {
  await started(w);
  w.setVerifier('FAIL', 1, [['P1', 'FAIL', 'regular_policy_applies']]); w.monitor();
  const incident = w.stateOf().incident;
  w.trust('owner');
  w.authorize({ incident: hex(), issued: w.now - 10, notAfter: w.now + 600 });
  assert.equal(w.recover().status, 1);
  w.setVerifier('FAIL', 1, [['L1', 'FAIL', 'latch_contained']]); w.setVerifierWhenInactive('PASS', 0);
  w.authorize({ incident, issued: w.now - 10, notAfter: w.now + 600 });
  const r = w.recover();
  assert.equal(r.status, 0, r.stderr);
  w.tick(30); await w.run();
  const codes = w.codes();
  for (const c of ['containment_started', 'topology_verification_fail', 'containment_confirmed', 'recovery_refused', 'recovery_authorized', 'recovery_completed']) assert.ok(codes.includes(c), c);
  assert.ok(w.lines().some((l) => l.startsWith('CRITICAL recovery_refused reason=authorization_incident')));
  noLeak(w);
  const alerts = readFileSync(join(w.state, 'alerts.jsonl'), 'utf8');
  assert.ok(!/nonce|signer|authorization v1|BEGIN SSH/.test(alerts), 'no nonce, signer or signed payload in the spool');
}));

// ------------------------------------------------------------------------------------------------ the real-broker driver's privacy check

test('the outgoing-privacy check: the approved runbook reference and incident ids are accepted; injected broker or authentication material is refused', () => {
  const ADMIN = 'Adm1nPassForTestsOnly9x';
  const COOKIE = 'QWERTYUIOPASDFGHJKLZXC';   // no sensitive word in it: only the exact-value rule can catch it
  const opts = { secrets: [ADMIN, COOKIE], provider: { token: TOKEN, user: USER } };
  const inc = '0123456789abcdef5672abcdef015672';   // the digits 5672 inside an incident id are not a port
  const event = `CRITICAL containment_started reason=verifier_fail incident=${inc} at=2026-10-25T10:30:00Z`;
  const msg = (...lines) => ({ url: '/1/messages.json', form: { token: TOKEN, user: USER, title: 'Nawara topology: containment_started', message: lines.join('\n'), priority: '1' }, raw: '' });
  const ping = { url: `/${HC_M}/20`, form: null, raw: '' };
  const check = (q) => outgoingPrivacyViolations([q], opts);
  // accepted
  assert.equal(APPROVED_RUNBOOK, /^readonly RUNBOOK='([^']+)'$/m.exec(readFileSync(join(SRC, 'topology-alert-carrier.sh'), 'utf8'))[1], 'the approved reference is the carrier\'s pin');
  assert.deepEqual(outgoingPrivacyViolations([msg(event, `runbook=${APPROVED_RUNBOOK}`), ping], opts), []);
  assert.deepEqual(check(msg(`WARNING monitor_overdue problems=monitor_overdue x5672 at=2026-10-25T10:30:00Z`, '+5672 more queued', `runbook=${APPROVED_RUNBOOK}`)), [], 'counts are not ports');
  assert.deepEqual(check(msg(`CRITICAL recovery_refused reason=authorization_incident incident=${inc} at=2026-10-25T10:30:00Z`, `runbook=${APPROVED_RUNBOOK}`)), [], 'a closed refusal code is not authentication material');
  // refused: each case names the finding, never the value
  const refused = {
    'the broker administrator password': msg(event, `note=${ADMIN}`, `runbook=${APPROVED_RUNBOOK}`),
    'a broker URL': msg(event, 'amqp://notification-service:x@rbcontain-1-rabbitmq:5672/nawara-core', `runbook=${APPROVED_RUNBOOK}`),
    'an https URL': msg(event, 'see https://example.invalid/x', `runbook=${APPROVED_RUNBOOK}`),
    'the Erlang cookie value (exact secret only)': msg(event, `c=${COOKIE}`, `runbook=${APPROVED_RUNBOOK}`),
    'the word erlang cookie': msg(event, 'erlang cookie leaked', `runbook=${APPROVED_RUNBOOK}`),
    'a bearer token': msg(event, 'Authorization: Bearer sk-live-CANARY', `runbook=${APPROVED_RUNBOOK}`),
    'a basic authorization header': msg(event, 'Authorization: Basic dXNlcjpwYXNz', `runbook=${APPROVED_RUNBOOK}`),
    'an authorization assignment': msg(event, 'authorization=abc', `runbook=${APPROVED_RUNBOOK}`),
    'a password assignment': msg(event, 'password=hunter2', `runbook=${APPROVED_RUNBOOK}`),
    'a private key': msg(event, '-----BEGIN OPENSSH PRIVATE KEY-----', `runbook=${APPROVED_RUNBOOK}`),
    'a credential alongside the correct runbook (same line)': msg(event, `runbook=${APPROVED_RUNBOOK} password=hunter2`),
    'a port :5672': msg(event, 'host rbcontain-1-rabbitmq:5672', `runbook=${APPROVED_RUNBOOK}`),
    'a port :15672': msg(event, 'management 127.0.0.1:15672', `runbook=${APPROVED_RUNBOOK}`),
    'a port=5672': msg(event, 'port=5672', `runbook=${APPROVED_RUNBOOK}`),
    'a RabbitMQ mention outside the runbook line': msg(`${event} rabbitmq`, `runbook=${APPROVED_RUNBOOK}`),
    'a substituted runbook': msg(event, 'runbook=docs/runbooks/other.md'),
    'a malformed runbook (spaces)': msg(event, `runbook = ${APPROVED_RUNBOOK}`),
    'a malformed runbook (case)': msg(event, `RUNBOOK=${APPROVED_RUNBOOK}`),
    'a runbook with a suffix': msg(event, `runbook=${APPROVED_RUNBOOK}?x=1`),
    'a JSON payload': msg(event, '{"synthetic":true}', `runbook=${APPROVED_RUNBOOK}`),
    'material in the title': { ...msg(event), form: { ...msg(event).form, title: 'Nawara topology: amqp://x' } },
    'material in an unknown field': { ...msg(event), form: { ...msg(event).form, extra: 'password=hunter2' } },
    'a substituted provider token': { ...msg(event), form: { ...msg(event).form, token: 'aOtherTokenForTestsOnly0000001' } },
    'the cookie in the provider user field': { ...msg(event), form: { ...msg(event).form, user: COOKIE } },
    'a heartbeat carrying a body': { ...ping, raw: 'cookie=abc' },
    'a heartbeat URL carrying a secret': { ...ping, url: `/${HC_M}/20?p=${ADMIN}` },
  };
  for (const [what, q] of Object.entries(refused)) {
    const v = check(q);
    assert.ok(v.length > 0, `${what}: refused`);
    assert.ok(!v.join('\n').includes(ADMIN) && !v.join('\n').includes(COOKIE) && !v.join('\n').includes('hunter2'), `${what}: the finding never repeats the value`);
  }
});

// ------------------------------------------------------------------------------------------------ message size: whole event lines only

const ISO0 = new Date(T0 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const CARRIER_SRC = readFileSync(join(SRC, 'topology-alert-carrier.sh'), 'utf8');
const pinNum = (name) => Number(new RegExp(`^readonly ${name}=(\\d+)$`, 'm').exec(CARRIER_SRC)[1]);
const MSG_MAX = pinNum('MSG_MAX');
/** The watchdog's closed problem codes, from its own `problem` calls (never a copy of the carrier's list). */
const WATCHDOG_PROBLEMS = [...readFileSync(join(SRC, 'topology-watchdog.sh'), 'utf8').replace(/^\s*#.*$/gm, '').matchAll(/\bproblem ([a-z_]+)/g)].map((m) => m[1]).filter((c, i, a) => a.indexOf(c) === i);
const WD = (kind, problems, { at = T0, severity = 'critical' } = {}) =>
  `{"v":1,"at":"${new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}","at_epoch":${at},"service":"notification-service","severity":"${severity}","kind":"watchdog_${kind}","problems":"${problems}"}`;
const WHOLE = /^(CRITICAL|WARNING|INFO) [a-z_]+( reason=[a-z0-9_]+)?( problems=[a-z_,]+)?( incident=[0-9a-f]{32})?( x\d+)? at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
/** Every message within MSG_MAX (decoded, and escaped: "\n" as two characters), every event line whole, the runbook last. */
function sizesHold(w) {
  for (const q of w.rx.pushes()) {
    const m = q.form.message;
    const lines = m.split('\n');
    assert.ok(m.length + (lines.length - 1) <= MSG_MAX, `a message of ${m.length} characters (${lines.length} lines) stays within ${MSG_MAX}`);
    assert.equal(lines.at(-1), `runbook=${APPROVED_RUNBOOK}`, 'the runbook reference is always the last line');
    for (const l of lines.slice(0, -1)) assert.ok(WHOLE.test(l) || /^OVERFLOW queue full: \d+ critical and \d+ other event\(s\) not queued individually; see alerts\.jsonl on the host$/.test(l) || /^\+\d+ more queued$/.test(l), `a whole line: ${l.slice(0, 60)}`);
  }
}
/** The line the carrier sends for an event (the test's own oracle). */
const lineOf = ({ severity = 'CRITICAL', code, reason, problems, incident, count = 1, at = ISO0 }) =>
  `${severity} ${code}${reason ? ` reason=${reason}` : ''}${problems ? ` problems=${problems}` : ''}${incident ? ` incident=${incident}` : ''}${count !== 1 ? ` x${count}` : ''} at=${at}`;
/** ACKNOWLEDGEMENT INTEGRITY: each expected event is either still queued, or was sent as its exact whole line; never removed in part. */
function eachAckedEventWhole(w, expected) {
  const sent = w.lines();
  const queuedIds = w.queued().map((r) => lineOf({ severity: r.severity.toUpperCase(), code: r.code, reason: r.reason, problems: r.problems, incident: r.incident === 'none' ? undefined : r.incident, count: r.count, at: r.at }));
  for (const e of expected) assert.ok(queuedIds.includes(e) !== sent.includes(e), `either queued or sent whole (exactly one): ${e.slice(0, 70)}`);
}
/** The budget for event lines with `queued` events and no overflow: MSG_MAX minus the reserved trailer (escaped lengths). */
const budgetFor = (queued, overflow = '') => MSG_MAX - `\\n${overflow ? `${overflow}\\n` : ''}+${queued} more queued\\nrunbook=${APPROVED_RUNBOOK}`.length;
/** Seven critical events whose escaped lines total exactly `total` characters (each line is 102 + reason length). */
function fill(w, total, k = 7) {
  const reasons = [];
  let left = total - 2 * (k - 1) - 102 * k;
  for (let i = 0; i < k; i++) { const r = Math.round(left / (k - i)); reasons.push(r); left -= r; }
  assert.ok(reasons.every((r) => r >= 1 && r <= 40), `reason lengths ${reasons} are within the contract`);
  return reasons.map((r, i) => {
    const incident = hex();
    const reason = `${'r'.repeat(r - 1)}${i}`.slice(-r);
    w.spool(MON('containment_started', { incident, reason }));
    return lineOf({ code: 'containment_started', reason, incident });
  });
}

test('size: the first event always fits: the largest accepted line is within MSG_MAX after the largest reserved trailer', () => {
  const codes = [...CARRIER_SRC.matchAll(/\[([a-z_]+)\]=(critical|warning|info)/g)].map((m) => m[1]);
  const longest = (a) => Math.max(...a.map((s) => s.length));
  assert.deepEqual([...WATCHDOG_PROBLEMS].sort(), ['monitor_killed', 'monitor_overdue', 'monitor_stalled', 'not_installed', 'service_failed', 'state_invalid', 'timer_inactive']);
  const problems = WATCHDOG_PROBLEMS.join(',');   // every closed code once: longer than any real combination (stalled and killed exclude each other)
  const line = `CRITICAL ${'x'.repeat(longest(codes))} reason=${'r'.repeat(40)} problems=${problems} incident=${'f'.repeat(32)} x999999 at=${ISO0}`;
  const overflow = 'OVERFLOW queue full: 999999999 critical and 999999999 other event(s) not queued individually; see alerts.jsonl on the host';
  const reserve = MSG_MAX - budgetFor(pinNum('QUEUE_MAX') + 2, overflow);
  assert.ok(line.length <= MSG_MAX - reserve, `the largest line (${line.length}) fits the smallest budget (${MSG_MAX - reserve})`);
});

test('size: at the exact boundary the batch is EXACTLY MSG_MAX; one character more and that event stays queued, then goes whole in the next message', withLab({}, async (w) => {
  await started(w); w.rx.requests.length = 0;
  // exact: seven events filling the budget to the character, an eighth that cannot fit
  const exact = [...fill(w, budgetFor(8)), ...fill(w, 102 + 10, 1)];
  let r = await w.run();
  assert.equal(r.code, 0, r.out);
  const [m1, m2] = w.rx.pushes().map((q) => q.form.message);
  assert.equal(m1.length + m1.split('\n').length - 1, MSG_MAX, 'the first message is exactly MSG_MAX (escaped)');
  assert.deepEqual(m1.split('\n').slice(0, 7), exact.slice(0, 7));
  assert.equal(m1.split('\n')[7], '+1 more queued', 'the remaining-events indicator is accurate');
  assert.deepEqual(m2.split('\n'), [exact[7], `runbook=${APPROVED_RUNBOOK}`], 'the event that did not fit went WHOLE in the next message');
  sizesHold(w); eachAckedEventWhole(w, exact); noLeak(w, r.out);
  // over by one: the seventh line no longer fits; it and the eighth stay queued, then go whole
  w.rx.requests.length = 0; w.tick(60);
  const over = [...fill(w, budgetFor(8) + 1), ...fill(w, 102 + 10, 1)];
  r = await w.run();
  assert.equal(r.code, 0, r.out);
  const [o1, o2] = w.rx.pushes().map((q) => q.form.message.split('\n'));
  assert.deepEqual(o1.slice(0, -2), over.slice(0, 6));
  assert.equal(o1.at(-2), '+2 more queued');
  assert.deepEqual(o2.slice(0, -1), over.slice(6));
  sizesHold(w); eachAckedEventWhole(w, over); noLeak(w, r.out);
}));

test('size: an event that does not fit is NOT acknowledged: with one batch per cycle it stays queued in full until a later cycle sends it whole', withLab({ carrierPins: { MAX_BATCHES: 1 } }, async (w) => {
  await started(w); w.rx.requests.length = 0;
  const lines = [...fill(w, budgetFor(9) + 1), ...fill(w, 2 * 102 + 10 + 2, 2)];
  let r = await w.run();
  assert.equal(r.code, 3, 'events stay queued');
  assert.equal(w.rx.pushes().length, 1);
  assert.deepEqual(w.queued().map((q) => q.reason), [lines[6], lines[7], lines[8]].map((l) => /reason=([a-z0-9_]+)/.exec(l)[1]), 'the three events that did not fit are queued, in order, complete');
  eachAckedEventWhole(w, lines);
  w.tick(60);
  r = await w.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(w.rx.pushes()[1].form.message.split('\n').slice(0, -1), lines.slice(6), 'a later cycle delivers them whole');
  assert.deepEqual(w.queue(), []);
  sizesHold(w); eachAckedEventWhole(w, lines); noLeak(w, r.out);
}));

test('size: the largest VALID watchdog events (the realistic six codes, and all seven) are accepted and delivered in full after a full batch', withLab({}, async (w) => {
  await started(w); w.rx.requests.length = 0;
  const six = 'not_installed,state_invalid,monitor_overdue,monitor_stalled,timer_inactive,service_failed';
  const seven = WATCHDOG_PROBLEMS.join(',');
  const lines = fill(w, budgetFor(10) - 20);
  for (const [i, p] of [six, seven].entries()) for (let k = 0; k < 3; k++) w.spool(WD('not_installed', p, { at: T0 + i * 10 + k }));
  const r = await w.run();
  assert.equal(r.code, 0, r.out);
  const sent = w.lines();
  for (const [i, p] of [six, seven].entries()) assert.ok(sent.includes(lineOf({ code: 'watchdog_not_installed', problems: p, count: 3, at: new Date((T0 + i * 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') })), `the ${p.split(',').length}-code event, coalesced x3, arrives whole`);
  assert.ok(!w.codes().includes('spool_event_rejected'), 'valid problem lists are never rejected');
  sizesHold(w); eachAckedEventWhole(w, lines); noLeak(w, r.out);
}));

test('size: an unknown, malformed or oversized problem list is refused as a fixed spool_event_rejected; its content never leaves the host', withLab({}, async (w) => {
  await started(w); w.rx.requests.length = 0;
  const bad = ['monitor_overdue,grant_everything', `${WATCHDOG_PROBLEMS.join(',')},monitor_overdue`, 'monitor_overdue,', ',monitor_overdue', 'monitor_overdue,,timer_inactive',
    'Monitor_overdue', 'monitor_overdue timer_inactive', `${'monitor_overdue,'.repeat(12)}monitor_overdue`, 'exfiltrated_code_canary'];
  for (const [i, p] of bad.entries()) w.spool(WD('monitor_overdue', p, { at: T0 + i }));
  const r = await w.run();
  assert.equal(r.code, 0, r.out);
  assert.ok(w.lines().some((l) => /^CRITICAL spool_event_rejected reason=malformed x9 at=/.test(l)), 'one fixed, coalesced rejection for the nine lines');
  assert.ok(!w.codes().includes('monitor_overdue'), 'none of them is accepted as an event');
  const out = `${w.rx.requests.map((q) => JSON.stringify(q.form ?? q.raw)).join('\n')}\n${r.out}`;
  for (const t of ['grant_everything', 'exfiltrated_code_canary', 'Monitor_overdue']) assert.ok(!out.includes(t), `the refused content (${t}) is never sent nor logged`);
  sizesHold(w); noLeak(w, r.out);
}));

test('size: saturation at the largest sizes: the OVERFLOW counters stay whole and correct, every message within MSG_MAX', withLab({ carrierPins: { QUEUE_MAX: 7 } }, async (w) => {
  await started(w); w.rx.requests.length = 0;
  const lines = fill(w, budgetFor(7) - 40);
  for (let i = 0; i < 3; i++) w.spool(MON('containment_started', { incident: hex(), reason: 'z'.repeat(40) }));
  w.spool(MON('topology_unknown_cleared', { severity: 'info' }).replace('"kind":"topology_unknown_cleared"', '"kind":"unknown_cleared"'));
  const r = await w.run();
  assert.equal(r.code, 0, r.out);
  assert.ok(w.lines().includes('OVERFLOW queue full: 3 critical and 1 other event(s) not queued individually; see alerts.jsonl on the host'), 'the counters are exact');
  sizesHold(w); eachAckedEventWhole(w, lines); noLeak(w, r.out);
}));

test('size: a message that cannot fit is never sent cut: fail-visible, nothing acknowledged, the queue untouched', withLab({ carrierPins: { MSG_MAX: 150 } }, async (w) => {
  const first = await w.run();   // carrier_started fits even this small budget? it must not be cut either way
  w.rx.requests.length = 0;
  const incident = hex();
  w.spool(MON('containment_started', { incident, reason: 'r'.repeat(40) }));
  const before = w.queued().length;
  const r = await w.run();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /delivery: the message would exceed 150 characters or carry no event; nothing sent, every event stays queued/);
  assert.equal(w.rx.pushes().length, 0, 'nothing is sent');
  assert.ok(w.queued().length >= before + 1 && w.queued().some((q) => q.incident === incident && q.reason === 'r'.repeat(40)), 'the event stays queued in full');
  assert.equal(w.crecords('deliveries.jsonl').at(-1).outcome, 'oversized');
  assert.ok(first.code === 0 || first.code === 3);
}));

test('size: a queued event left by an earlier carrier with a 200-character problem list (the old contract) is still delivered WHOLE, never cut', withLab({}, async (w) => {
  await started(w); w.rx.requests.length = 0;
  // six lines of exactly 760 characters: the old carrier's gate let one more line in, then cut the message at 1000
  const lines = fill(w, 760, 6);
  const problems = `${'monitor_overdue,'.repeat(13)}monitor_ove`.slice(0, 200);
  const old = `{"v":1,"id":"${hex()}","code":"watchdog_not_installed","severity":"critical","component":"watchdog","at":"${ISO0}","at_epoch":${T0},"incident":"none","reason":"","problems":"${problems}","count":1,"last_epoch":${T0},"queued_epoch":${T0}}`;
  const f = join(w.carrierDir, 'queue', `0-999999999999-${'a'.repeat(16)}.json`);
  writeFileSync(f, `${old}\n`, { mode: 0o600 }); chmodSync(f, 0o600);
  const r = await w.run();
  assert.equal(r.code, 0, r.out);
  const whole = lineOf({ code: 'watchdog_not_installed', problems });
  assert.ok(whole.length > 240, 'longer than the old cut could carry after a full batch');
  assert.ok(w.lines().includes(whole), 'the long event arrives whole (in a later message of the cycle)');
  assert.ok(!existsSync(f), 'acknowledged only once sent whole');
  sizesHold(w); eachAckedEventWhole(w, [...lines, whole]); noLeak(w, r.out);
}));

// ------------------------------------------------------------------------------------------------ OD-BRK-2b-W (W2): parked lines

test('W2: 11: lines parked while the spool\'s lock was held reach the carrier whole and in order once a run flushes them', withLab({}, async (w) => {
  await started(w);
  w.setVerifier('PASS', 0); assert.equal(w.monitor().status, 0); assert.equal(w.watchdog().status, 0);
  w.tick(30); assert.equal((await w.run()).code, 0); w.rx.requests.length = 0;
  const holder = spawn('flock', [join(w.state, 'alerts.lock'), 'sleep', '60'], { detached: true, stdio: 'ignore' });
  spawnSync('sleep', ['0.3']);
  let incident;
  try {
    w.setVerifier('FAIL', 1, [['P1', 'FAIL', 'regular_policy_applies']]);
    const m = w.monitor();
    assert.equal(m.status, 20, m.stdout + m.stderr);
    assert.match(m.stdout, /the line is parked/);
    incident = w.stateOf().incident;
    w.tick(30);
    assert.ok([0, 3].includes((await w.run()).code));
    assert.ok(!w.lines().some((l) => l.includes(incident)), 'parked lines are not in the spool yet: nothing of the incident is sent');
  } finally { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ } spawnSync('sleep', ['0.2']); }
  // the lock is free: the watchdog's next run flushes the parked lines (it alerts nothing new for them), the carrier delivers them
  w.tick(30);
  w.watchdog();
  assert.deepEqual(readdirSync(join(w.state, 'alerts.pending')).filter((f) => f.endsWith('.line')), [], 'nothing left parked');
  w.tick(30);
  const r = await w.run();
  assert.ok([0, 3].includes(r.code), r.out);
  const sent = w.lines().filter((l) => l.includes(`incident=${incident}`)).map((l) => /^CRITICAL ([a-z_]+) /.exec(l)?.[1]);
  assert.deepEqual(sent, ['containment_started', 'topology_verification_fail', 'containment_confirmed'], 'whole, in their order');
  noLeak(w, r.out);
}));

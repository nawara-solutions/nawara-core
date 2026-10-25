// Core V2 OD-BRK-2b-1: infra/rabbitmq/topology-monitor against a fake broker CLI and a stub verifier, unprivileged (the reviewed scripts,
// re-pinned only in their locations, uids and timing: lib/topology-monitor-world.mjs). The real verifier, root ownership, a real broker
// and a real sshd are certified by scripts/deploy-tests/real-broker-topology-containment.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATCH_CONTAINED, LATCH_INACTIVE, ROLE, ROOT, SRC, authorizationText, hex, variant, world } from './lib/topology-monitor-world.mjs';

const SERVICE = 'notification-service';
const monitor = (w, args = [SERVICE], env = {}) => spawnSync(join(w.install, 'verify-and-contain.sh'), args, { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 60_000 });
const brokerChanges = (w) => w.broker().calls.filter((c) => ['clear_permissions', 'clear_topic_permissions', 'close_all_user_connections'].includes(c.sub));
const kinds = (w) => w.records('alerts.jsonl').map((a) => a.kind);
/** Holds the monitor's lock from another process (its own process group, so releasing it frees the lock at once). */
const holdLock = (w) => {
  const c = spawn('flock', [join(w.state, 'lock'), 'sleep', '30'], { detached: true, stdio: 'ignore' });
  spawnSync('sleep', ['0.3']);
  return () => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } spawnSync('sleep', ['0.2']); };
};
const lastAlert = (w, prefix) => w.records('alerts.jsonl').filter((a) => a.kind.startsWith(prefix)).at(-1);
const withWorld = (opts, fn) => () => {
  const w = world(opts);
  let r;
  try {
    r = fn(w);
  } catch (e) {
    w.cleanup();
    throw e;
  }
  if (r && typeof r.then === 'function') return r.finally(() => w.cleanup());
  w.cleanup();
  return r;
};
const assertContained = (w) => {
  const b = w.broker();
  assert.deepEqual(b.perms[SERVICE] ?? {}, {}, 'no resource permission left');
  assert.deepEqual(b.topic[SERVICE] ?? {}, {}, 'no topic permission left');
  assert.ok(!b.connections.includes(SERVICE), 'no connection left');
  assert.ok(b.connections.includes('audit-service') && b.perms['audit-service']['nawara-core'], 'only Notification is touched');
  assert.equal(w.latchText(), LATCH_CONTAINED);
  assert.equal(w.stateOf().contained, 1);
};

// ------------------------------------------------------------------------------------------------ the state machine

test('PASS resets the UNKNOWN counter, never touches the latch or the broker, and exits 0', withWorld({ state: { streak: 2, last: 'UNKNOWN' } }, (w) => {
  const r = monitor(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([w.stateOf().streak, w.stateOf().last, w.stateOf().contained], [0, 'PASS', 0]);
  assert.equal(w.latchText(), LATCH_INACTIVE);
  assert.deepEqual(brokerChanges(w), []);
  assert.ok(kinds(w).includes('unknown_cleared'));
  assert.match(r.stdout, /result=PASS reason=verified/);
}));

test('the verifier runs with only its own pinned environment, in the phase the broker implies (pre-grant without a grant)', withWorld({}, (w) => {
  assert.equal(monitor(w, [SERVICE], { SECRET_SHOULD_NOT_PASS: 'x', RABBITMQ_CONTAINER: 'evil' }).status, 0);
  w.patchBroker((b) => { delete b.perms[SERVICE]; delete b.topic[SERVICE]; });
  assert.equal(monitor(w).status, 0);
  w.patchBroker((b) => { delete b.users[SERVICE]; });
  assert.equal(monitor(w).status, 0);
  const calls = w.verifierCalls();
  assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['post-grant', 'pre-grant', 'pre-grant']);
  for (const c of calls) {
    assert.doesNotMatch(c, /SECRET_SHOULD_NOT_PASS/);
    assert.deepEqual(c.split(' ').slice(1).filter(Boolean).filter((n) => !['PWD', 'SHLVL', '_'].includes(n)),
      ['EXPECTED_TOPIC_READ', 'EXPECTED_TOPIC_WRITE', 'LC_ALL', 'NOTIFICATION_CONTAINMENT_STATE', 'PATH', 'PROPOSED_PERM_CONF', 'PROPOSED_PERM_READ', 'PROPOSED_PERM_WRITE', 'RABBITMQ_CONTAINER']);
  }
}));

test('FAIL contains immediately: intent persisted BEFORE the first broker change, grants revoked, connections closed, two read-backs', withWorld({}, (w) => {
  w.setVerifier('FAIL', 1, [['L1', 'PASS', 'latch_inactive'], ['P1', 'FAIL', 'regular_policy_applies']]);
  const r = monitor(w);
  assert.equal(r.status, 20, r.stderr);
  assertContained(w);
  const changes = brokerChanges(w);
  assert.ok(changes.length > 0);
  assert.equal(changes[0].sub, 'clear_permissions');
  for (const c of changes) assert.equal(c.latch, LATCH_CONTAINED, 'the latch said contained before every broker change');
  // the two confirmations: after the last change, two complete read-backs (users, grants, topic grants, connections)
  const after = w.broker().calls.slice(w.broker().calls.lastIndexOf(changes.at(-1)) + 1).map((c) => c.sub);
  assert.equal(after.filter((s) => s === 'list_connections').length, 2);
  const ev = w.records('evidence.jsonl').at(-1);
  assert.deepEqual([ev.result, ev.reason, ev.checks, ev.containment, ev.attempts], ['FAIL', 'verifier_fail', 'P1', 'confirmed', 1]);
  assert.ok(kinds(w).includes('contained'));
  assert.match(r.stdout, /CONTAINED/);
}));

test('UNKNOWN: #1 recorded and alerted, #2 escalated, #3 contained; the counter is durable across runs', withWorld({}, (w) => {
  w.setVerifier('UNKNOWN', 3, [['B0', 'UNKNOWN', 'broker_not_reachable']]);
  assert.equal(monitor(w).status, 10);
  assert.deepEqual([w.stateOf().streak, lastAlert(w, 'unknown_').kind, lastAlert(w, 'unknown_').severity], [1, 'unknown_first', 'warning']);
  assert.deepEqual(brokerChanges(w), []);
  assert.equal(monitor(w).status, 10);
  assert.deepEqual([w.stateOf().streak, lastAlert(w, 'unknown_').kind, lastAlert(w, 'unknown_').severity], [2, 'unknown_escalated', 'critical']);
  assert.deepEqual(brokerChanges(w), []);
  assert.equal(monitor(w).status, 20);
  assertContained(w);
  assert.equal(w.records('evidence.jsonl').at(-1).reason, 'unknown_3');
}));

test('a definitive FAIL overrides UNKNOWN (contained at once, whatever the counter)', withWorld({ state: { streak: 1, last: 'UNKNOWN' } }, (w) => {
  w.setVerifier('FAIL', 1, [['U2', 'FAIL', 'other_identity_reaches_notification_queue'], ['Q1', 'UNKNOWN', 'queue_listing_unparseable']]);
  assert.equal(monitor(w).status, 20);
  assertContained(w);
  assert.equal(w.records('evidence.jsonl').at(-1).reason, 'verifier_fail');
}));

test('an invalid or inconsistent verifier answer is UNKNOWN, never PASS', withWorld({}, (w) => {
  const cases = [
    [0, 'garbage'],
    [0, ''],
    [1, '{"verifier":"verify-topology","version":1,"service":"notification-service","phase":"@PHASE@","result":"PASS","completeness":"full","checks":[]}'],
    [0, '{"verifier":"verify-topology","version":1,"service":"notification-service","phase":"@PHASE@","result":"FAIL","completeness":"full","checks":[]}'],
    [2, '{"verifier":"verify-topology","result":"UNKNOWN","reason":"usage"}'],
    [0, '{"verifier":"verify-topology","version":1,"service":"billing-service","phase":"@PHASE@","result":"PASS","completeness":"full","checks":[]}'],
  ];
  for (const [i, [exit, line]] of cases.entries()) {
    w.writeState({});
    w.setVerifierRaw(exit, line);
    assert.equal(monitor(w).status, 10, `case ${i}`);
    assert.equal(w.stateOf().last, 'UNKNOWN', `case ${i}`);
    assert.match(w.records('evidence.jsonl').at(-1).reason, /^verifier_(output_invalid|inconsistent)$/, `case ${i}`);
  }
  // a broker that cannot be listed is UNKNOWN too
  w.writeState({});
  w.setVerifier('PASS', 0);
  w.patchBroker((b) => { b.failList = ['list_users']; });
  assert.equal(monitor(w).status, 10);
  assert.equal(w.records('evidence.jsonl').at(-1).reason, 'broker_listing_failed');
}));

// ------------------------------------------------------------------------------------------------ containment, confirmed or not

test('once contained, a PASS restores nothing: the containment is re-applied and re-confirmed, the verifier is not even consulted', withWorld({}, (w) => {
  w.setVerifier('FAIL', 1);
  assert.equal(monitor(w).status, 20);
  w.setVerifier('PASS', 0);
  const before = w.verifierCalls().length;
  assert.equal(monitor(w).status, 20);
  assert.equal(monitor(w).status, 20);
  assert.equal(w.verifierCalls().length, before, 'no verification decides anything while contained');
  assertContained(w);
  assert.deepEqual(w.records('evidence.jsonl').slice(-2).map((e) => [e.mode, e.reason]), [['contained', 'containment_maintained'], ['contained', 'containment_maintained']]);
  assert.equal(kinds(w).filter((k) => k === 'contained').length, 1, 'the containment alert is raised once, not every run');
  // a grant that reappears (someone re-granted by hand) is revoked again on the next run
  w.patchBroker((b) => { b.perms[SERVICE] = { 'nawara-core': [ROLE.conf, ROLE.write, ROLE.conf] }; b.connections.push(SERVICE); });
  assert.equal(monitor(w).status, 20);
  assertContained(w);
}));

for (const [what, fault] of [['a silent revocation failure (exit 0, grants kept)', { silentRevoke: true }], ['a silent connection-close failure (exit 0, connection kept)', { silentClose: true }], ['an unreadable connection listing', { failList: ['list_connections'] }]]) {
  test(`${what} is CONTAINMENT_UNCONFIRMED after the bounded attempts, never CONTAINED`, withWorld({ broker: fault }, (w) => {
    w.setVerifier('FAIL', 1);
    const r = monitor(w);
    assert.equal(r.status, 21, r.stdout);
    assert.match(r.stdout, /CONTAINMENT_UNCONFIRMED/);
    assert.doesNotMatch(r.stdout, /\] CONTAINED$/m);
    const ev = w.records('evidence.jsonl').at(-1);
    assert.deepEqual([ev.containment, ev.attempts], ['unconfirmed', 3]);
    assert.ok(kinds(w).includes('containment_unconfirmed'));
    assert.equal(w.latchText(), LATCH_CONTAINED, 'the intent is still persisted');
    assert.equal(w.stateOf().contained, 1);
    // the next run retries (and keeps reporting) instead of forgetting
    assert.equal(monitor(w).status, 21);
  }));
}

test('partial containment: grants revoked but the latch cannot be persisted (its directory is a symbolic link) is UNCONFIRMED', withWorld({}, (w) => {
  const real = `${w.latchDir}-real`;
  renameSync(w.latchDir, real);
  symlinkSync(real, w.latchDir);
  w.setVerifier('FAIL', 1);
  assert.equal(monitor(w).status, 21);
  const b = w.broker();
  assert.deepEqual(b.perms[SERVICE], {}, 'the revocation still happened (the safer action is never skipped)');
  assert.equal(readFileSync(join(real, 'notification-service.containment'), 'utf8'), LATCH_INACTIVE, 'nothing was written through the link');
}));

test('a latch reset to inactive while the state says contained is put back (and alerted); a contained latch alone also contains', withWorld({}, (w) => {
  w.setVerifier('FAIL', 1);
  assert.equal(monitor(w).status, 20);
  writeFileSync(w.latch, LATCH_INACTIVE);
  assert.equal(monitor(w).status, 20);
  assert.equal(w.latchText(), LATCH_CONTAINED);
  assert.ok(kinds(w).includes('latch_restored_by_monitor'));
  const w2 = world({ latch: LATCH_CONTAINED });
  try {
    assert.equal(monitor(w2).status, 20);
    assertContained(w2);
    assert.equal(w2.records('evidence.jsonl').at(-1).reason, 'latch_contained');
  } finally {
    w2.cleanup();
  }
}));

test('an alert spool that cannot be written never blocks the containment', withWorld({}, (w) => {
  mkdirSync(join(w.state, 'alerts.jsonl'));
  w.setVerifier('FAIL', 1);
  const r = monitor(w);
  assert.equal(r.status, 20);
  assertContained(w);
  assert.match(r.stdout, /alert spool unavailable/);
}));

// ------------------------------------------------------------------------------------------------ the state's integrity

for (const [what, prepare, reason] of [
  ['missing after installation', (w) => rmSync(join(w.state, 'state')), 'state_missing'],
  ['corrupt', (w) => writeFileSync(join(w.state, 'state'), 'contained=0\n'), 'state_corrupt'],
  ['a forged counter beyond the format', (w) => writeFileSync(join(w.state, 'state'), 'nawara-core-topology-monitor-state v1\nservice=notification-service\ncontained=0\nunknown_streak=-1\nlast_result=PASS\nlast_run=0\n'), 'state_corrupt'],
  ['a symbolic link', (w) => { const t = join(w.base, 'elsewhere'); writeFileSync(t, readFileSync(join(w.state, 'state'))); rmSync(join(w.state, 'state')); symlinkSync(t, join(w.state, 'state')); }, 'state_symlink'],
  ['weakly permissioned', (w) => chmodSync(join(w.state, 'state'), 0o644), 'state_unsafe'],
  ['without the installation marker', (w) => rmSync(join(w.state, 'installed')), 'marker_invalid'],
]) {
  test(`a state ${what} is never trusted or re-initialized: it is set aside and Notification is contained`, withWorld({}, (w) => {
    prepare(w);
    const r = monitor(w);
    assert.equal(r.status, 20, r.stdout + r.stderr);
    assertContained(w);
    const ev = w.records('evidence.jsonl').at(-1);
    assert.deepEqual([ev.mode, ev.reason], ['integrity', reason]);
    if (reason === 'state_symlink') assert.equal(readFileSync(join(w.base, 'elsewhere'), 'utf8').includes('contained=0'), true, 'never written through the link');
  }));
}

test('not installed (no state directory) refuses and changes nothing; an unsafe state directory refuses', withWorld({ installed: false }, (w) => {
  const r = monitor(w);
  assert.equal(r.status, 78);
  assert.deepEqual(w.broker().calls, []);
  assert.equal(w.latchText(), LATCH_INACTIVE);
  mkdirSync(w.state);
  chmodSync(w.state, 0o755);
  assert.equal(monitor(w).status, 65);
  assert.deepEqual(w.broker().calls, []);
}));

test('two runs at once are serialized by the lock: the state stays valid and counts both', withWorld({}, async (w) => {
  w.setVerifier('UNKNOWN', 3, [['B0', 'UNKNOWN', 'broker_not_reachable']]);
  const go = () => new Promise((res) => { const c = spawn(join(w.install, 'verify-and-contain.sh'), [SERVICE], { env: { PATH: '/usr/bin:/bin' } }); c.on('close', res); });
  const codes = await Promise.all([go(), go(), go()]);
  assert.deepEqual(codes.sort(), [10, 10, 20], 'the third consecutive UNKNOWN contains, exactly once');
  assert.deepEqual([w.stateOf().streak, w.stateOf().contained], [3, 1]);
  assert.equal(w.records('evidence.jsonl').length, 3);
  assert.ok(!existsSync(join(w.state, 'running')), 'no run marker is left behind');
}));

test('the lock is bounded: a run that cannot take it in time refuses (75) and changes nothing', withWorld({ pins: { LOCK_WAIT: 1 } }, (w) => {
  const release = holdLock(w);
  try {
    assert.equal(monitor(w).status, 75);
    assert.deepEqual(w.broker().calls, []);
  } finally {
    release();
  }
}));

test('records are bounded', withWorld({ pins: { RECORD_MAX_LINES: 4 } }, (w) => {
  for (let i = 0; i < 9; i += 1) assert.equal(monitor(w).status, 0);
  assert.ok(w.records('evidence.jsonl').length <= 4);
}));

// ------------------------------------------------------------------------------------------------ the invocation and the installation

test('only the fixed target, never a client command, never as another user; an altered installation refuses before anything', withWorld({}, (w) => {
  for (const [args, env] of [[[], {}], [['billing-service'], {}], [[SERVICE, 'x'], {}], [[SERVICE], { SSH_ORIGINAL_COMMAND: 'rabbitmqctl delete_user x' }]]) {
    assert.equal(monitor(w, args, env).status, 64, JSON.stringify(args));
  }
  assert.deepEqual(w.broker().calls, [], 'nothing reached the broker');
  w.put('verify-and-contain.sh', { RUN_AS_UID: process.getuid() + 1 });
  assert.equal(monitor(w).status, 65, 'not the pinned user');
  w.put('verify-and-contain.sh');
  chmodSync(w.install, 0o775);
  assert.equal(monitor(w).status, 65, 'a group-writable install directory');
  chmodSync(w.install, 0o755);
  chmodSync(join(w.install, 'verify-topology.sh'), 0o644);
  writeFileSync(join(w.install, 'verify-topology.sh'), `${readFileSync(join(w.install, 'verify-topology.sh'), 'utf8')}# altered\n`);
  assert.equal(monitor(w).status, 66, 'the verifier does not match its pin');
  const copy = join(w.base, 'verify-and-contain.sh');
  cpSync(join(w.install, 'verify-and-contain.sh'), copy);
  assert.equal(spawnSync(copy, [SERVICE], { encoding: 'utf8' }).status, 65, 'run from anywhere but the install directory');
  assert.deepEqual(w.broker().calls, []);
}));

// ------------------------------------------------------------------------------------------------ the watchdog

const watchdogWorld = (opts = {}) => {
  const w = world({ scripts: ['verify-and-contain.sh', 'topology-watchdog.sh'], ...opts });
  const systemctl = join(w.shim, 'systemctl');
  writeFileSync(systemctl, `#!/usr/bin/env bash\nstate=$(cat ${JSON.stringify(join(w.ctl, 'units'))} 2>/dev/null || echo 'timer=active service=ok')\ncase "$1 $3" in\n  "is-active nawara-core-topology-monitor.timer") [[ $state == *timer=active* ]] ;;\n  "is-failed nawara-core-topology-monitor.service") [[ $state == *service=failed* ]] ;;\n  *) exit 9 ;;\nesac\n`, { mode: 0o755 });
  w.put('topology-watchdog.sh', { SYSTEMCTL: systemctl });
  w.units = (s) => writeFileSync(join(w.ctl, 'units'), s);
  w.watchdog = () => spawnSync(join(w.install, 'topology-watchdog.sh'), [], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000 });
  return w;
};
const now = () => Math.floor(Date.now() / 1000);

test('watchdog: a fresh, healthy monitor is ok; a missed run is overdue; a run holding the lock too long is stalled; a killed run is reported', () => {
  const w = watchdogWorld();
  try {
    assert.equal(monitor(w).status, 0);
    let r = w.watchdog();
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /status=ok/);
    w.writeState({ last: 'PASS', run: now() - 1000 });
    r = w.watchdog();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /status=monitor_overdue/);
    w.writeState({ last: 'PASS', run: now() });
    writeFileSync(join(w.state, 'running'), `started=${now() - 400} pid=1`);
    const release = holdLock(w);
    try {
      r = w.watchdog();
      assert.match(r.stdout, /problems=monitor_stalled/);
    } finally {
      release();
    }
    r = w.watchdog();
    assert.match(r.stdout, /problems=monitor_killed/, 'a marker with no run holding the lock');
    rmSync(join(w.state, 'running'));
    assert.deepEqual(w.broker().calls.filter((c) => c.sub !== 'list_users' && !c.sub.startsWith('list_')), [], 'the watchdog changes nothing on the broker');
  } finally {
    w.cleanup();
  }
});

test('watchdog: an inactive timer, a failed unit and an invalid state are reported; alerts on a change of status, not on every check', () => {
  const w = watchdogWorld();
  try {
    assert.equal(monitor(w).status, 0);
    w.units('timer=inactive service=ok');
    assert.match(w.watchdog().stdout, /problems=timer_inactive/);
    assert.match(w.watchdog().stdout, /problems=timer_inactive/);
    w.units('timer=active service=failed');
    assert.match(w.watchdog().stdout, /problems=service_failed/);
    w.units('timer=active service=ok');
    writeFileSync(join(w.state, 'state'), 'garbage');
    assert.match(w.watchdog().stdout, /state_invalid/);
    const alerts = w.records('alerts.jsonl').filter((a) => 'problems' in a).map((a) => a.kind); // the watchdog's own alerts
    assert.deepEqual(alerts, ['watchdog_timer_inactive', 'watchdog_service_failed', 'watchdog_state_invalid'], 'one alert per change of status');
    assert.ok(w.records('watchdog.jsonl').length >= 4, 'every check is recorded');
    // and the monitor sees the watchdog's check-in (mutual monitoring)
    w.writeState({ last: 'PASS', run: now() });
    assert.equal(monitor(w).status, 0);
    assert.equal(w.records('evidence.jsonl').at(-1).watchdog, 'ok');
  } finally {
    w.cleanup();
  }
});

test('watchdog: contained is reported (informational), arguments and client commands are refused, and it never touches the latch', () => {
  const w = watchdogWorld();
  try {
    w.setVerifier('FAIL', 1);
    assert.equal(monitor(w).status, 20);
    const r = w.watchdog();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /status=contained/);
    assert.equal(spawnSync(join(w.install, 'topology-watchdog.sh'), ['x'], { encoding: 'utf8' }).status, 64);
    assert.equal(spawnSync(join(w.install, 'topology-watchdog.sh'), [], { env: { SSH_ORIGINAL_COMMAND: 'id' }, encoding: 'utf8' }).status, 64);
    assert.equal(w.latchText(), LATCH_CONTAINED);
  } finally {
    w.cleanup();
  }
});

test('the monitor alerts when the watchdog has gone quiet (absent or stale), at most once an hour', withWorld({}, (w) => {
  assert.equal(monitor(w).status, 0);
  assert.equal(monitor(w).status, 0);
  assert.equal(kinds(w).filter((k) => k === 'watchdog_quiet').length, 1);
  writeFileSync(join(w.state, 'watchdog'), `nawara-core-topology-watchdog v1\nlast_run=${now() - 5000}\nstatus=ok\nlast_alert=0\n`, { mode: 0o600 });
  assert.equal(monitor(w).status, 0);
  assert.equal(w.records('evidence.jsonl').at(-1).watchdog, 'stale');
}));

// ------------------------------------------------------------------------------------------------ the trigger (forced command)

test('trigger: refuses any client command or argument (64), runs exactly one start of the monitor unit with an empty environment', () => {
  const w = world({ scripts: [] });
  try {
    const sudo = join(w.shim, 'sudo');
    writeFileSync(sudo, `#!/usr/bin/env bash\nprintf '%s|%s\\n' "$*" "$(env | cut -d= -f1 | sort | tr '\\n' ' ')" >> ${JSON.stringify(join(w.ctl, 'sudo-calls'))}\nexit 0\n`, { mode: 0o755 });
    const entry = w.put('topology-trigger.sh', { SUDO: sudo });
    const run = (args, env = {}) => spawnSync(entry, args, { env: { PATH: '/usr/bin:/bin', HOME: '/tmp', ...env }, encoding: 'utf8' });
    for (const [args, env] of [[[], { SSH_ORIGINAL_COMMAND: 'id' }], [[], { SSH_ORIGINAL_COMMAND: 'sh -c "rm -rf /"' }], [['--now'], {}], [[], { SSH_ORIGINAL_COMMAND: 'internal-sftp' }]]) {
      const r = run(args, env);
      assert.equal(r.status, 64, JSON.stringify([args, env]));
      assert.doesNotMatch(r.stderr, /rm -rf|internal-sftp|\bid\b/, 'the client command is never printed');
    }
    assert.ok(!existsSync(join(w.ctl, 'sudo-calls')), 'nothing was started');
    const r = run([], { SECRET: 'x' });
    assert.equal(r.status, 0, r.stderr);
    const [argsLine, envLine] = readFileSync(join(w.ctl, 'sudo-calls'), 'utf8').trim().split('|');
    assert.equal(argsLine, '-n /usr/bin/systemctl start nawara-core-topology-monitor.service');
    assert.doesNotMatch(envLine, /SECRET|HOME/);
    // an unsafe installation refuses
    chmodSync(w.install, 0o777);
    assert.equal(run([]).status, 65);
  } finally {
    w.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ incidents (OD-BRK-2b-R)

const HEX = /^[0-9a-f]{32}$/;
test('a new containment gets a fresh incident, persisted with the state BEFORE the binding, the latch and any broker change', withWorld({}, (w) => {
  w.setVerifier('FAIL', 1);
  assert.equal(monitor(w).status, 20);
  const { incident } = w.stateOf();
  assert.match(incident, HEX);
  assert.equal(w.boundIncident(), incident, 'the incident is bound next to the latch');
  assert.deepEqual(w.records('incidents.jsonl').map((r) => r.incident), [incident]);
  assert.equal(w.records('evidence.jsonl').at(-1).incident, incident);
  assert.equal(w.records('alerts.jsonl').find((a) => a.kind === 'contained').incident, incident);
  const changes = brokerChanges(w);
  assert.ok(changes.length > 0 && changes.every((c) => c.latch === LATCH_CONTAINED));
}));

test('the incident is kept across maintained runs and unconfirmed retries, never overwritten', withWorld({ broker: { silentRevoke: true } }, (w) => {
  w.setVerifier('FAIL', 1);
  assert.equal(monitor(w).status, 21);
  const { incident } = w.stateOf();
  assert.equal(monitor(w).status, 21);
  w.patchBroker((b) => { b.silentRevoke = false; });
  assert.equal(monitor(w).status, 20);
  assert.equal(monitor(w).status, 20);
  assert.equal(w.stateOf().incident, incident);
  assert.equal(w.records('incidents.jsonl').length, 1, 'one incident, however many runs');
  // a binding altered next to the latch is put back from the state (and alerted), never adopted
  w.writeIncident(hex());
  assert.equal(monitor(w).status, 20);
  assert.equal(w.boundIncident(), incident);
  assert.ok(kinds(w).includes('incident_binding_restored'));
}));

test('legacy (v1) state: not contained upgrades to v2 without an incident; contained gets a FRESH incident and stays contained', () => {
  const w = world({ state: null });
  try {
    w.writeState({ v1: true, contained: 0, last: 'PASS' });
    assert.equal(monitor(w).status, 0);
    assert.deepEqual([w.stateOf().contained, w.stateOf().incident], [0, 'none']);
    w.writeState({ v1: true, contained: 1, last: 'FAIL' });
    writeFileSync(w.latch, LATCH_CONTAINED);
    assert.equal(monitor(w).status, 20);
    assert.match(w.stateOf().incident, HEX);
    assert.equal(w.records('evidence.jsonl').at(-1).reason, 'legacy_containment_new_incident');
  } finally {
    w.cleanup();
  }
});

test('an inconsistent state (contained without an incident, or an incident while not contained) is corrupt: contained', () => {
  for (const [contained, incident] of [[1, 'none'], [0, hex()]]) {
    const w = world({ state: { contained, incident } });
    try {
      assert.equal(monitor(w).status, 20);
      assert.equal(w.records('evidence.jsonl').at(-1).reason, 'state_corrupt');
      assert.match(w.stateOf().incident, HEX);
    } finally {
      w.cleanup();
    }
  }
});

test('a corrupt state with a valid bound incident and a contained latch keeps that incident (never a silent new one)', withWorld({}, (w) => {
  w.setVerifier('FAIL', 1);
  assert.equal(monitor(w).status, 20);
  const { incident } = w.stateOf();
  writeFileSync(join(w.state, 'state'), 'garbage');
  assert.equal(monitor(w).status, 20);
  assert.equal(w.stateOf().incident, incident);
}));

// ------------------------------------------------------------------------------------------------ signed recovery (OD-BRK-2b-R)

const recover = (w, env = {}) => spawnSync(join(w.install, 'recover-notification-topology.sh'), [], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 60_000 });
/** Contained by a FAIL, with the trusted key installed and the verifier answering as a contained-but-safe topology. */
const containedWorld = () => {
  const w = world({ scripts: ['verify-and-contain.sh', 'recover-notification-topology.sh'] });
  w.setVerifier('FAIL', 1);
  assert.equal(monitor(w).status, 20);
  w.setVerifier('FAIL', 1, [['L1', 'FAIL', 'latch_contained'], ['Q1', 'PASS', 'queue_as_declared_no_policy']]);
  w.setVerifierWhenInactive('PASS', 0);
  w.trust('owner');
  w.incident = w.stateOf().incident;
  return w;
};
const withContained = (fn) => () => {
  const w = containedWorld();
  let r;
  try {
    r = fn(w);
  } catch (e) {
    w.cleanup();
    throw e;
  }
  if (r && typeof r.then === 'function') return r.finally(() => w.cleanup());
  w.cleanup();
  return r;
};
const assertStillContained = (w, incident = w.incident) => {
  assert.equal(w.latchText(), LATCH_CONTAINED);
  assert.deepEqual([w.stateOf().contained, w.stateOf().incident], [1, incident]);
  assert.equal(w.boundIncident(), incident);
  assert.ok(!w.broker().calls.some((c) => /^set_/.test(c.sub)), 'nothing was granted');
};

test('signed recovery: a valid, incident-bound, unexpired, unused authorization clears the latch ONLY; nothing is granted', withContained((w) => {
  const grants = JSON.stringify(w.broker().perms);
  const auth = w.authorize({ incident: w.incident, reason: 'OD-RECOVERY-7' });
  const r = recover(w);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /holds NO grant/);
  assert.equal(w.latchText(), LATCH_INACTIVE);
  assert.deepEqual([w.stateOf().contained, w.stateOf().incident], [0, 'none']);
  assert.equal(w.boundIncident(), 'none');
  assert.equal(JSON.stringify(w.broker().perms), grants, 'no permission changed');
  assert.ok(!w.broker().calls.some((c) => /^set_/.test(c.sub)), 'no set_permissions or set_topic_permissions, ever');
  const nonce = /nonce=([0-9a-f]{32})/.exec(auth)[1];
  assert.match(readFileSync(join(w.state, 'recovery-consumed'), 'utf8'), new RegExp(`^v1 nonce=${nonce} incident=${w.incident} at=\\d+$`, 'm'));
  const ev = w.records('evidence.jsonl').filter((e) => e.kind?.startsWith('recover'));
  assert.deepEqual(ev.map((e) => e.kind), ['recovery_authorized', 'recovered']);
  for (const e of ev) {
    assert.deepEqual([e.incident, e.nonce, e.reason], [w.incident, nonce, 'OD-RECOVERY-7'], e.kind);
    assert.match(e.signer, /^SHA256:[A-Za-z0-9+/]{43}$/, `${e.kind}: the signing key's fingerprint is recorded`);
  }
  assert.ok(!existsSync(join(w.inbox, 'authorization')), 'the inbox is emptied');
  assert.equal(monitor(w).status, 0, 'the monitor resumes');
  // a new containment is a NEW incident: the previous authorization (and any for the previous incident) no longer applies
  rmSync(join(w.ctl, 'verifier-inactive'));
  w.setVerifier('FAIL', 1);
  assert.equal(monitor(w).status, 20);
  assert.notEqual(w.stateOf().incident, w.incident);
  assert.match(w.stateOf().incident, HEX);
  w.authorize({ incident: w.incident });
  w.setVerifier('FAIL', 1, [['L1', 'FAIL', 'latch_contained']]);
  assert.match(recover(w).stderr, /REFUSED \(authorization_incident\)/);
  assertStillContained(w, w.stateOf().incident);
}));

const later = Math.floor(Date.now() / 1000);
for (const [what, prepare, code] of [
  ['an altered signed text (tampered after signing)', (w) => { w.authorize({ incident: w.incident }); const a = join(w.inbox, 'authorization'); writeFileSync(a, readFileSync(a, 'utf8').replace('reason=OD-RECOVERY-1', 'reason=OD-RECOVERY-2')); }, /signature_invalid/],
  ['a signature by another key', (w) => w.authorize({ incident: w.incident, key: 'intruder' }), /signature_invalid/],
  ['a signature in another namespace', (w) => w.authorize({ incident: w.incident, namespace: 'nawara-core-other' }), /signature_invalid/],
  ['no signature at all', (w) => w.authorize({ incident: w.incident, sign: false }), /authorization_file/],
  ['a garbage signature', (w) => { w.authorize({ incident: w.incident }); writeFileSync(join(w.inbox, 'authorization.sig'), 'not a signature\n'); }, /signature_format/],
  ['another operation', (w) => w.authorize({ incident: w.incident, operation: 'notification.topology_grant' }), /authorization_operation/],
  ['another service', (w) => w.authorize({ incident: w.incident, service: 'billing-service' }), /authorization_target/],
  ['another vhost', (w) => w.authorize({ incident: w.incident, vhost: 'other-vhost' }), /authorization_target/],
  ['another incident', (w) => w.authorize({ incident: hex() }), /authorization_incident/],
  ['an expired authorization', (w) => w.authorize({ incident: w.incident, issued: later - 4000, notAfter: later - 1000 }), /authorization_expired/],
  ['an authorization issued in the future', (w) => w.authorize({ incident: w.incident, issued: later + 1000, notAfter: later + 1600 }), /authorization_window/],
  ['a validity window longer than an hour', (w) => w.authorize({ incident: w.incident, issued: later - 10, notAfter: later + 3600 }), /authorization_window/],
  ['an empty validity window', (w) => w.authorize({ incident: w.incident, issued: later, notAfter: later }), /authorization_window/],
  ['an unsupported version', (w) => w.authorize({ incident: w.incident, version: 'v2' }), /authorization_version/],
  ['a duplicate field', (w) => w.authorize({ text: authorizationText({ incident: w.incident }).replace('vhost=nawara-core\n', 'vhost=nawara-core\nvhost=nawara-core\n') }), /authorization_format/],
  ['an unknown field', (w) => w.authorize({ text: authorizationText({ incident: w.incident }).replace('reason=', 'grant=yes\nreason=') }), /authorization_format/],
  ['CRLF line ends', (w) => w.authorize({ text: authorizationText({ incident: w.incident }).replace(/\n/g, '\r\n') }), /authorization_format/],
  ['a trailing space', (w) => w.authorize({ text: authorizationText({ incident: w.incident }).replace('service=notification-service', 'service=notification-service ') }), /authorization_format/],
  ['no final newline', (w) => w.authorize({ text: authorizationText({ incident: w.incident }).trimEnd() }), /authorization_format/],
  ['reordered fields', (w) => w.authorize({ text: authorizationText({ incident: w.incident }).replace(/^(.*\n)(operation=.*\n)(service=.*\n)/, '$1$3$2') }), /authorization_format/],
  ['an uppercase incident', (w) => w.authorize({ text: authorizationText({ incident: w.incident.toUpperCase() }) }), /authorization_format/],
  ['a NUL byte', (w) => w.authorize({ text: authorizationText({ incident: w.incident }).replace('reason=OD', 'reason=O\0D') }), /authorization_format/],
  ['a weakly permissioned authorization file', (w) => { w.authorize({ incident: w.incident }); chmodSync(join(w.inbox, 'authorization'), 0o666); }, /authorization_file/],
  ['an authorization that is a symbolic link', (w) => { w.authorize({ incident: w.incident }); const a = join(w.inbox, 'authorization'); renameSync(a, join(w.base, 'elsewhere')); symlinkSync(join(w.base, 'elsewhere'), a); }, /authorization_file/],
]) {
  test(`signed recovery refuses ${what}; containment unchanged`, withContained((w) => {
    prepare(w);
    const r = recover(w);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, code);
    assertStillContained(w);
    assert.ok(!existsSync(join(w.state, 'recovery-consumed')), 'nothing was consumed');
  }));
}

for (const [what, prepare] of [
  ['no trusted key', (w) => rmSync(w.trusted)],
  ['a trusted key for a wildcard principal (ssh-keygen would accept it)', (w) => w.trust('owner', { raw: readFileSync(w.trusted, 'utf8').replace('nawara-core-owner ', 'nawara-core-* ') })],
  ['a trusted key for another principal', (w) => w.trust('owner', { raw: readFileSync(w.trusted, 'utf8').replace('nawara-core-owner ', 'someone ') })],
  ['a trusted key without the namespace restriction', (w) => w.trust('owner', { raw: readFileSync(w.trusted, 'utf8').replace(' namespaces="nawara-core-topology-recovery"', '') })],
  ['a trusted key with an extra option', (w) => w.trust('owner', { raw: readFileSync(w.trusted, 'utf8').replace('namespaces=', 'valid-before="29991231",namespaces=') })],
  ['two trusted keys', (w) => { const one = readFileSync(w.trusted, 'utf8'); w.trust('intruder'); writeFileSync(w.trusted, one + readFileSync(w.trusted, 'utf8')); }],
  ['a group-writable trusted key', (w) => chmodSync(w.trusted, 0o664)],
  ['a trusted key that is a symbolic link', (w) => { renameSync(w.trusted, `${w.trusted}.real`); symlinkSync(`${w.trusted}.real`, w.trusted); }],
]) {
  test(`signed recovery refuses ${what} (65), even with an otherwise valid authorization`, withContained((w) => {
    w.authorize({ incident: w.incident });
    prepare(w);
    const r = recover(w);
    assert.equal(r.status, 65, r.stderr);
    assertStillContained(w);
  }));
}

test('signed recovery: no argument and no forced command; a containment that does not hold or an unsafe topology refuses', withContained((w) => {
  w.authorize({ incident: w.incident });
  assert.equal(spawnSync(join(w.install, 'recover-notification-topology.sh'), ['OD-RECOVERY-1'], { encoding: 'utf8' }).status, 2, 'no argument selects anything');
  assert.equal(recover(w, { SSH_ORIGINAL_COMMAND: 'x' }).status, 2);
  w.patchBroker((b) => { b.connections.push(SERVICE); });
  assert.match(recover(w).stderr, /containment_not_holding/);
  w.patchBroker((b) => { b.connections = b.connections.filter((u) => u !== SERVICE); });
  w.setVerifier('FAIL', 1, [['L1', 'FAIL', 'latch_contained'], ['P1', 'FAIL', 'regular_policy_applies']]);
  assert.match(recover(w).stderr, /topology_unsafe/);
  w.writeIncident(hex());
  assert.match(recover(w).stderr, /incident_binding/);
  w.writeIncident(w.incident);
  assertStillContained(w);
  assert.ok(!existsSync(join(w.state, 'recovery-consumed')));
}));

test('single use: a replay of a consumed authorization is refused, including after a crash that kept the incident contained', withContained((w) => {
  w.authorize({ incident: w.incident });
  const auth = readFileSync(join(w.inbox, 'authorization'));
  const sig = readFileSync(join(w.inbox, 'authorization.sig'));
  // a crash right after the consumption was flushed: still contained, the nonce spent
  w.crashAt('sync', 'recovery-consumed', 'after');
  assert.notEqual(recover(w).status, 0);
  assertStillContained(w);
  assert.match(readFileSync(join(w.state, 'recovery-consumed'), 'utf8'), /nonce=/);
  const r = recover(w);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /authorization_replay/);
  assertStillContained(w);
  // a fresh authorization (new nonce) for the same incident then succeeds once, and its replay finds nothing to recover
  w.authorize({ incident: w.incident });
  assert.equal(recover(w).status, 0);
  writeFileSync(join(w.inbox, 'authorization'), auth, { mode: 0o600 });
  writeFileSync(join(w.inbox, 'authorization.sig'), sig, { mode: 0o600 });
  assert.match(recover(w).stderr, /not_contained/);
}));

test('crash safety: before the consumption nothing changes; while clearing, the service stays contained or is re-contained as a NEW incident', withContained((w) => {
  // before the consumption (while the authorization is being copied): containment preserved, nothing consumed
  w.authorize({ incident: w.incident });
  w.crashAt('cp', 'authorization.sig', 'before');
  assert.notEqual(recover(w).status, 0);
  assertStillContained(w);
  assert.ok(!existsSync(join(w.state, 'recovery-consumed')), 'nothing was consumed');
  // during the latch clearing (the state already says not contained, the latch still contained): no grant, and the monitor re-contains
  w.crashAt('mv', 'notification-service.containment', 'before');
  assert.notEqual(recover(w).status, 0);
  assert.equal(w.latchText(), LATCH_CONTAINED);
  assert.deepEqual([w.stateOf().contained, w.stateOf().incident], [0, 'none']);
  assert.ok(!w.broker().calls.some((c) => /^set_/.test(c.sub)));
  w.setVerifier('PASS', 0);
  assert.equal(monitor(w).status, 20, 'a contained latch alone contains');
  const next = w.stateOf().incident;
  assert.match(next, HEX);
  assert.notEqual(next, w.incident, 'a new incident: the consumed authorization of the old one can never apply');
  assert.equal(w.records('evidence.jsonl').at(-1).reason, 'latch_contained');
}));

test('concurrency: two recoveries with the same authorization at once: exactly one succeeds', withContained(async (w) => {
  w.authorize({ incident: w.incident });
  // the rendezvous inside the section the lock serializes (after the replay check, before the consumption): without the lock BOTH
  // guards reach it; with the lock the second one waits at flock, then finds nothing contained and never reaches it
  writeFileSync(join(w.ctl, 'barrier'), '');
  const go = () => new Promise((res) => { const c = spawn(join(w.install, 'recover-notification-topology.sh'), [], { env: { PATH: '/usr/bin:/bin' } }); c.on('close', res); });
  const codes = await Promise.all([go(), go()]);
  assert.equal(readdirSync(w.ctl).filter((f) => f.startsWith('arrived.')).length, 1, 'only one guard was ever inside the serialized section');
  assert.deepEqual(codes.sort(), [0, 1]);
  assert.equal(readFileSync(join(w.state, 'recovery-consumed'), 'utf8').trim().split('\n').length, 1, 'consumed once');
  assert.equal(w.latchText(), LATCH_INACTIVE);
}));

// ------------------------------------------------------------------------------------------------ installation and its verification
// The authenticated installation lifecycle (OD-BRK-2b-I) is certified by scripts/deploy-tests/topology-monitor-install.test.mjs.

test('the four units: never reference a workflow, run the pinned paths, and treat UNKNOWN (10) and CONTAINED (20) as success', () => {
  const unit = (n) => readFileSync(join(SRC, n), 'utf8');
  assert.match(unit('nawara-core-topology-monitor.service'), /^ExecStart=\/usr\/local\/libexec\/nawara-core-topology\/verify-and-contain\.sh notification-service$/m);
  assert.match(unit('nawara-core-topology-monitor.service'), /^SuccessExitStatus=10 20$/m);
  assert.doesNotMatch(unit('nawara-core-topology-monitor.service'), /^StateDirectory=/m, 'never an empty state created by systemd');
  assert.match(unit('nawara-core-topology-monitor.timer'), /^OnUnitActiveSec=5min$/m);
  assert.match(unit('nawara-core-topology-watchdog.service'), /^ExecStart=\/usr\/local\/libexec\/nawara-core-topology\/topology-watchdog\.sh$/m);
  assert.match(unit('nawara-core-topology-watchdog.timer'), /^Unit=nawara-core-topology-watchdog\.service$/m);
  for (const f of readdirSync(join(ROOT, '.github/workflows'))) {
    assert.doesNotMatch(readFileSync(join(ROOT, '.github/workflows', f), 'utf8'), /topology-monitor|nawara-core-topology|verify-and-contain/, `${f} never installs or starts the control`);
  }
});

// ------------------------------------------------------------------------------------------------ OD-BRK-2b-W (W2): the alert spool's lock

/** A script run in the background: resolves { status, out } (bounded by the test's own timeout). */
const startScript = (path) => new Promise((resolve) => {
  const c = spawn(path, [], { env: { PATH: '/usr/bin:/bin' } });
  let out = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.on('close', (status) => resolve({ status, out }));
});
const startMonitor = (w) => new Promise((resolve) => {
  const c = spawn(join(w.install, 'verify-and-contain.sh'), [SERVICE], { env: { PATH: '/usr/bin:/bin' } });
  let out = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.on('close', (status) => resolve({ status, out }));
});
const waitFor = async (p, ms = 10_000) => { const end = Date.now() + ms; while (!existsSync(p)) { assert.ok(Date.now() < end, `${p} within ${ms} ms`); await new Promise((r) => setTimeout(r, 50)); } };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** A spool exactly at its bound (RECORD_MAX_LINES): the next append trims it to the newest half. */
const fillSpool = (w, n = 2000) => {
  const f = join(w.state, 'alerts.jsonl');
  writeFileSync(f, Array.from({ length: n }, (_, i) => `{"v":1,"kind":"filler","n":${i}}`).join('\n') + '\n', { mode: 0o600 });
  chmodSync(f, 0o600);
};
const spoolLines = (w) => readFileSync(join(w.state, 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean);
/**
 * Starts the watchdog so that its alert append TRIMS the spool, and pauses it between reading the newest lines and the rename.
 * Resolves { run } (the watchdog's completion), wrapped: an async function that returned the bare promise would wait for it.
 */
const watchdogPausedInTrim = async (w) => {
  fillSpool(w);
  writeFileSync(join(w.ctl, 'pause'), 'mv alerts.jsonl\n');
  const run = startScript(join(w.install, 'topology-watchdog.sh'));
  await waitFor(join(w.ctl, 'paused'));
  return { run };
};

test('W2: 6: a trim racing an append drops NO line: the monitor\'s alert waits for the watchdog\'s trim, then lands after it, intact and in order', async () => {
  const w = watchdogWorld();
  try {
    assert.equal(monitor(w).status, 0);
    const { run: wd } = await watchdogPausedInTrim(w);
    assert.equal(spawnSync('flock', ['-n', '-E', '99', join(w.state, 'alerts.lock'), 'true']).status, 99, 'the paused trim holds the spool\'s lock');
    w.setVerifier('UNKNOWN', 3, [['B0', 'UNKNOWN', 'broker_not_reachable']]);
    const mon = startMonitor(w);
    await sleepMs(500);   // the monitor is now waiting for the spool's lock, held by the paused trim
    assert.ok(!spoolLines(w).some((l) => l.includes('"kind":"unknown_first"')), 'the monitor did not append into the file being trimmed');
    writeFileSync(join(w.ctl, 'release'), '');
    const [rw, rm] = await Promise.all([wd, mon]);
    assert.equal(rm.status, 10, rm.out);
    assert.doesNotMatch(rm.out, /alert spool lock unavailable/, 'the lock was acquired within its bound');
    assert.ok(!existsSync(join(w.state, 'alerts.pending')), 'nothing parked');
    assert.ok([0, 1].includes(rw.status), rw.out);
    const lines = spoolLines(w);
    const monitorAlerts = (rm.out.match(/\] ALERT severity=/g) ?? []).length;
    assert.ok(monitorAlerts >= 1);
    assert.equal(lines.length, 1000 + monitorAlerts, 'trimmed to the newest half, then every one of the monitor\'s lines after the trim');
    assert.match(lines[999], /"kind":"watchdog_ok"/, 'the watchdog\'s own line survived its trim');
    assert.deepEqual(lines.slice(1000).map((l) => JSON.parse(l).kind)[0], 'unknown_first', 'the monitor\'s lines, appended after the trim, are not lost');
    for (const l of lines) JSON.parse(l);   // every line complete
  } finally { w.cleanup(); }
});

test('W2: 10: a recovery\'s alert racing the watchdog\'s trim is not lost either', async () => {
  const w = containedWorld();
  try {
    const systemctl = join(w.shim, 'systemctl');
    writeFileSync(systemctl, '#!/usr/bin/env bash\ncase "$1" in is-active) exit 0 ;; is-failed) exit 1 ;; *) exit 9 ;; esac\n', { mode: 0o755 });
    w.put('topology-watchdog.sh', { SYSTEMCTL: systemctl });
    const { run: wd } = await watchdogPausedInTrim(w);
    const rec = startScript(join(w.install, 'recover-notification-topology.sh'));   // no authorization in the inbox: refused, alerted
    await sleepMs(500);
    writeFileSync(join(w.ctl, 'release'), '');
    const [, rr] = await Promise.all([wd, rec]);
    assert.equal(rr.status, 1, rr.out);
    assert.match(rr.out, /REFUSED \(authorization_file\)/);
    const lines = spoolLines(w);
    assert.match(lines.at(-1), /"kind":"recovery_refused"/, 'the recovery\'s line survives the trim');
    assert.equal(lines.length, 1000 + 1);
    assert.equal(w.latchText(), LATCH_CONTAINED, 'containment unchanged');
  } finally { w.cleanup(); }
});

test('W2: 7, 12: with the spool\'s lock held elsewhere, a containment still completes within its bound; its lines are PARKED, then appended in order', () => {
  const w = world();
  try {
    const lock = join(w.state, 'alerts.lock');
    const holder = spawn('flock', [lock, 'sleep', '60'], { detached: true, stdio: 'ignore' });
    spawnSync('sleep', ['0.3']);
    let parked;
    try {
      fillSpool(w);
      w.setVerifier('FAIL', 1);
      const t0 = Date.now();
      const r = monitor(w);
      const ms = Date.now() - t0;
      assert.equal(r.status, 20, r.stdout + r.stderr);
      assert.equal(w.latchText(), LATCH_CONTAINED);
      assert.deepEqual(brokerChanges(w).map((c) => c.sub).slice(0, 2), ['clear_permissions', 'clear_topic_permissions'], 'the grants were revoked');
      const waits = (r.stdout.match(/alert spool lock unavailable within 2s: the line is parked for the next writer that holds it/g) ?? []).length;
      assert.ok(waits >= 3, `every alert of the run waited at most 2 s, then was parked (${waits})`);
      assert.ok(ms < waits * 2_000 + 8_000, `bounded: ${ms} ms for ${waits} alerts waiting at most 2 s each`);
      assert.equal(spoolLines(w).length, 2000, 'nothing appended or trimmed without the lock');
      parked = readdirSync(join(w.state, 'alerts.pending')).filter((f) => f.endsWith('.line')).sort()
        .map((f) => JSON.parse(readFileSync(join(w.state, 'alerts.pending', f), 'utf8')).kind);
      assert.equal(parked.length, waits);
      assert.deepEqual(parked.slice(0, 3), ['containment_started', 'verification_fail', 'contained'], 'parked whole, in their order');
    } finally { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ } spawnSync('sleep', ['0.2']); }
    // the next run, once the lock is free, flushes the parked lines, in order, even with nothing new to alert; none lost, none left
    w.setVerifier('FAIL', 1);
    const r2 = monitor(w);
    assert.equal(r2.status, 20, r2.stdout + r2.stderr);
    assert.doesNotMatch(r2.stdout, /alert spool lock unavailable/);
    const kinds2 = spoolLines(w).map((l) => JSON.parse(l).kind).filter((k) => k !== 'filler');
    assert.deepEqual(kinds2.slice(0, parked.length), parked, 'every parked line, in its order, reached the spool (then trimmed with the rest, never lost)');
    assert.deepEqual(readdirSync(join(w.state, 'alerts.pending')).filter((f) => f.endsWith('.line')), []);
    // an unusable lock (a directory) never blocks containment either: parked, never lost
    rmSync(lock, { force: true });
    mkdirSync(lock);
    w.writeState({});
    w.writeIncident('none');
    writeFileSync(w.latch, LATCH_INACTIVE);
    const r3 = monitor(w);
    assert.equal(r3.status, 20, r3.stdout + r3.stderr);
    assert.match(r3.stdout, /the line is parked/);
    assert.ok(readdirSync(join(w.state, 'alerts.pending')).filter((f) => f.endsWith('.line')).length >= 3);
  } finally { w.cleanup(); }
});

test('W2: 8, 9: a watchdog killed while holding its locks frees them; a second watchdog at the same time refuses (75) and changes nothing', async () => {
  const w = watchdogWorld();
  try {
    assert.equal(monitor(w).status, 0);
    // 9: two watchdogs at once: the second finds the first holding its lock
    const { run: first } = await watchdogPausedInTrim(w);
    const before = readFileSync(join(w.state, 'alerts.jsonl'), 'utf8');
    const second = w.watchdog();
    assert.equal(second.status, 75, second.stdout + second.stderr);
    assert.equal(readFileSync(join(w.state, 'alerts.jsonl'), 'utf8'), before, 'the refused run wrote nothing');
    writeFileSync(join(w.ctl, 'release'), '');
    await first;
    rmSync(join(w.ctl, 'release'));
    // 8: killed inside the trim (before the rename), holding the watchdog's and the spool's locks
    fillSpool(w, 2001);
    rmSync(join(w.state, 'watchdog'));   // a status change, so it alerts (and trims)
    w.crashAt('mv', 'alerts.jsonl', 'before');
    const killed = w.watchdog();
    assert.equal(killed.signal, 'SIGKILL', 'killed inside its trim');
    assert.equal(spoolLines(w).length, 2002, 'killed before the rename: the spool is untouched, its new line kept');
    // the kernel released both locks with the process: the next writers proceed at once
    w.setVerifier('UNKNOWN', 3, [['B0', 'UNKNOWN', 'broker_not_reachable']]);
    const t0 = Date.now();
    const r = monitor(w);
    assert.equal(r.status, 10, r.stdout + r.stderr);
    assert.ok(Date.now() - t0 < 2_000 + 3_000);
    assert.doesNotMatch(r.stdout, /alert spool lock unavailable/);
    assert.notEqual(w.watchdog().status, 75, 'no stale lock');
    assert.ok(spoolLines(w).some((l) => l.includes('"kind":"unknown_first"')));
  } finally { w.cleanup(); }
});

// ------------------------------------------------------------------------------------------------ OD-BRK-2b-W (C1, C2, C3): parked lines

/** Holds the spool's lock from another process for the duration of `fn` (its own process group: released at once afterwards). */
const withSpoolLockHeld = async (w, fn) => {
  const holder = spawn('flock', [join(w.state, 'alerts.lock'), 'sleep', '60'], { detached: true, stdio: 'ignore' });
  spawnSync('sleep', ['0.3']);
  try { return await fn(); } finally { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ } spawnSync('sleep', ['0.2']); }
};
const pendingDir = (w) => join(w.state, 'alerts.pending');
const parkedFiles = (w) => (existsSync(pendingDir(w)) ? readdirSync(pendingDir(w)).filter((f) => f.endsWith('.line')).sort() : []);
const orphanFiles = (w) => (existsSync(pendingDir(w)) ? readdirSync(pendingDir(w)).filter((f) => f.startsWith('.tmp.')) : []);
const traced = (w) => readFileSync(join(w.ctl, 'trace'), 'utf8').split('\n').filter(Boolean);
const UNKNOWN_RUN = [['B0', 'UNKNOWN', 'broker_not_reachable']];

test('C1: a parked line is published only whole and durably: written, synced, renamed, its directory synced; merged ones removed only after the spool is synced', async () => {
  const w = world();
  try {
    writeFileSync(join(w.ctl, 'trace'), '');
    await withSpoolLockHeld(w, () => { w.setVerifier('UNKNOWN', 3, UNKNOWN_RUN); assert.equal(monitor(w).status, 10); });
    const files = parkedFiles(w);
    assert.ok(files.length >= 1);
    const calls = traced(w);
    const d = pendingDir(w);
    // the directory itself, new, is synced into the state directory first
    assert.ok(calls.includes(`sync -- ${w.state}`), 'the new pending directory is made durable');
    for (const f of files) {
      const mvAt = calls.findIndex((c) => c.startsWith('mv -f -- ') && c.endsWith(` ${join(d, f)}`));
      assert.ok(mvAt > 0, `${f} was published by a rename`);
      const tmp = calls[mvAt].split(' ')[3];
      assert.match(tmp, /\/alerts\.pending\/\.tmp\.[A-Za-z0-9]{8}$/, 'from a unique temporary file in the same directory');
      assert.ok(calls.slice(0, mvAt).includes(`sync -- ${tmp}`), `${f}: its content synced BEFORE the rename`);
      assert.ok(calls.slice(mvAt + 1).includes(`sync -- ${d}`), `${f}: the directory synced AFTER the rename`);
      assert.equal(statSync(join(d, f)).mode & 0o777, 0o600);
    }
    assert.equal(statSync(d).mode & 0o777, 0o700);
    assert.deepEqual(orphanFiles(w), []);
    // the merge: appended, the spool synced, and only then the parked files removed
    writeFileSync(join(w.ctl, 'trace'), '');
    w.setVerifier('PASS', 0);
    assert.equal(monitor(w).status, 0);
    const merge = traced(w);
    const syncAt = merge.indexOf(`sync -- ${join(w.state, 'alerts.jsonl')}`);
    assert.ok(syncAt >= 0, 'the spool is synced before the parked files go');
    assert.deepEqual(parkedFiles(w), []);
  } finally { w.cleanup(); }
});

test('C1: a failed sync never publishes a partial line: no parked file, no temporary left, the failure in the journal, containment unaffected', async () => {
  const w = world();
  try {
    await withSpoolLockHeld(w, () => {
      writeFileSync(join(w.ctl, 'fail'), 'sync alerts.pending/.tmp.\n');   // the content sync of the first parked line fails
      w.setVerifier('FAIL', 1);
      const r = monitor(w);
      assert.equal(r.status, 20, r.stdout + r.stderr);
      assert.equal(w.latchText(), LATCH_CONTAINED, 'containment never depends on the spool');
      assert.match(r.stdout, /alert spool unavailable \(kind=containment_started\); containment never depends on it/);
      assert.ok(!parkedFiles(w).some((f) => readFileSync(join(pendingDir(w), f), 'utf8').includes('"kind":"containment_started"')), 'the unsynced line was never published');
      assert.deepEqual(orphanFiles(w), [], 'its temporary file was removed');
      assert.ok(parkedFiles(w).length >= 2, 'the next lines park normally');
    });
    // a failed directory sync after the rename: the line is published (whole), and the journal says its durability is not confirmed
    await withSpoolLockHeld(w, () => {
      writeFileSync(join(w.ctl, 'fail'), `sync =-- ${pendingDir(w)}\n`);   // exactly the directory's sync, after the rename
      w.setVerifier('UNKNOWN', 3, UNKNOWN_RUN);
      w.writeState({});
      w.writeIncident('none');
      writeFileSync(w.latch, LATCH_INACTIVE);
      const r = monitor(w);
      assert.match(r.stdout, /a parked line is published, but its directory could not be synced/);
    });
  } finally { w.cleanup(); }
});

test('C1: a merge interrupted before its sync, or whose sync fails, repeats lines and never loses one', async () => {
  const w = watchdogWorld();
  try {
    assert.equal(monitor(w).status, 0);
    await withSpoolLockHeld(w, () => { w.setVerifier('UNKNOWN', 3, UNKNOWN_RUN); assert.equal(monitor(w).status, 10); });
    const lines = parkedFiles(w).map((f) => readFileSync(join(pendingDir(w), f), 'utf8'));
    assert.ok(lines.length >= 1);
    // the spool's sync keeps failing: the lines are appended, but the parked files stay
    writeFileSync(join(w.ctl, 'fail-always'), `sync =-- ${join(w.state, 'alerts.jsonl')}\n`);
    w.watchdog();
    assert.equal(parkedFiles(w).length, lines.length, 'not removed without a synced spool');
    assert.ok(lines.every((l) => spoolLines(w).includes(l)), 'yet appended: the next merge repeats them, never loses them');
    rmSync(join(w.ctl, 'fail-always'));
    // killed right after the spool's sync, before the removal: next time the lines are appended again (duplicates), never lost
    w.crashAt('sync', join(w.state, 'alerts.jsonl'), 'after');
    w.watchdog();
    assert.equal(parkedFiles(w).length, lines.length, 'killed before the removal: still parked');
    w.watchdog();
    assert.deepEqual(parkedFiles(w), [], 'a later run removes them once merged and synced');
    const spool = spoolLines(w);
    for (const l of lines) assert.ok(spool.filter((x) => x === l).length >= 1, 'every parked line reached the spool (possibly more than once)');
  } finally { w.cleanup(); }
});

test('C2: two writers parking concurrently: each keeps its own order, and the merge follows the file-name sort key', async () => {
  const w = watchdogWorld();
  try {
    assert.equal(monitor(w).status, 0);
    rmSync(join(w.state, 'watchdog'), { force: true });   // the watchdog alerts (a change of status) and the monitor reports it quiet
    await withSpoolLockHeld(w, async () => {
      w.setVerifier('FAIL', 1);   // a containment: three lines, always in this order, from one writer
      const [m, d] = await Promise.all([startMonitor(w), startScript(join(w.install, 'topology-watchdog.sh'))]);
      assert.equal(m.status, 20, m.out);
      assert.ok([0, 1].includes(d.status), d.out);
    });
    const files = parkedFiles(w);
    const meta = files.map((f) => { const [ns, pid, seq] = f.split('.'); return { f, ns, pid, seq: Number(seq), kind: JSON.parse(readFileSync(join(pendingDir(w), f), 'utf8')).kind }; });
    assert.ok(new Set(meta.map((x) => x.pid)).size === 2, `two writers parked (${files.join(', ')})`);
    for (const pid of new Set(meta.map((x) => x.pid))) {
      const own = meta.filter((x) => x.pid === pid);
      assert.deepEqual(own.map((x) => x.seq), own.map((_, i) => i + 1), 'each writer numbers its own lines 1, 2, ... in its own order');
    }
    assert.ok(meta.every((x) => /^\d{19}$/.test(x.ns)), 'the sort key starts with a fixed-width nanosecond time');
    const monitorKinds = meta.filter((x) => ['containment_started', 'verification_fail', 'contained'].includes(x.kind)).map((x) => x.kind);
    assert.deepEqual(monitorKinds, ['containment_started', 'verification_fail', 'contained'], 'the monitor\'s own order survives the sort');
    // the merge (the next writer holding the lock) appends them exactly in sort-key order
    w.watchdog();
    const kinds = spoolLines(w).map((l) => JSON.parse(l).kind);
    const at = kinds.indexOf(meta[0].kind);
    assert.deepEqual(kinds.slice(at, at + meta.length), meta.map((x) => x.kind), 'merged in sort-key order');
  } finally { w.cleanup(); }
});

test('C3: a crash while publishing leaves an unpublished temporary file: never merged, never taken as an accepted line, and inspectable', async () => {
  const w = watchdogWorld();
  try {
    assert.equal(monitor(w).status, 0);
    await withSpoolLockHeld(w, () => {
      w.crashAt('mv', 'alerts.pending/.tmp.', 'before');   // killed between the synced temporary file and its rename
      w.setVerifier('UNKNOWN', 3, UNKNOWN_RUN);
      const r = monitor(w);
      assert.equal(r.signal, 'SIGKILL');
    });
    const orphans = orphanFiles(w);
    assert.equal(orphans.length, 1, 'one unpublished temporary file');
    assert.match(readFileSync(join(pendingDir(w), orphans[0]), 'utf8'), /"kind":"unknown_first"/, 'its content is inspectable');
    assert.deepEqual(parkedFiles(w), [], 'never published');
    w.watchdog();
    assert.ok(!spoolLines(w).some((l) => l.includes('"kind":"unknown_first"')), 'never merged into the spool');
    assert.deepEqual(orphanFiles(w), orphans, 'and never removed automatically (left for an investigation)');
  } finally { w.cleanup(); }
});

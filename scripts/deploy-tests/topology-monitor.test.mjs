// Core V2 OD-BRK-2b-1: infra/rabbitmq/topology-monitor against a fake broker CLI and a stub verifier, unprivileged (the reviewed scripts,
// re-pinned only in their locations, uids and timing: lib/topology-monitor-world.mjs). The real verifier, root ownership, a real broker
// and a real sshd are certified by scripts/deploy-tests/real-broker-topology-containment.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATCH_CONTAINED, LATCH_INACTIVE, ROLE, ROOT, SRC, variant, world } from './lib/topology-monitor-world.mjs';

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

// ------------------------------------------------------------------------------------------------ recovery (contract and guard)

const hasScript = spawnSync('script', ['--version']).status === 0;
/** Runs the recovery guard on a pseudo-terminal (it refuses a pipe), typing `typed`. */
const recover = (w, ref, typed) => {
  const cmd = `${join(w.install, 'recover-notification-topology.sh')} ${ref}`;
  return spawnSync('script', ['-qec', cmd, '/dev/null'], { input: `${typed}\n`, env: { PATH: '/usr/bin:/bin', TERM: 'dumb' }, encoding: 'utf8', timeout: 60_000 });
};
const containedWorld = () => {
  const w = world({ scripts: ['verify-and-contain.sh', 'recover-notification-topology.sh'] });
  w.setVerifier('FAIL', 1);
  assert.equal(monitor(w).status, 20);
  return w;
};

test('recovery: refused without a terminal, without a valid reference, or through a forced command; nothing changes', () => {
  const w = containedWorld();
  try {
    const entry = join(w.install, 'recover-notification-topology.sh');
    assert.equal(spawnSync(entry, ['OD-RECOVERY-1'], { input: 'x\n', encoding: 'utf8' }).status, 2, 'no terminal');
    assert.equal(spawnSync(entry, [], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(entry, ['bad ref'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(entry, ['OD-RECOVERY-1'], { env: { SSH_ORIGINAL_COMMAND: 'x' }, encoding: 'utf8' }).status, 2);
    assert.equal(w.latchText(), LATCH_CONTAINED);
  } finally {
    w.cleanup();
  }
});

test('recovery: a wrong confirmation, a containment that does not hold or another failing check refuses; the latch stays contained', { skip: !hasScript && 'util-linux script(1) is not available' }, () => {
  const w = containedWorld();
  try {
    w.setVerifier('FAIL', 1, [['L1', 'FAIL', 'latch_contained']]);
    assert.equal(recover(w, 'OD-RECOVERY-1', 'RECOVER notification-service OD-RECOVERY-2').status, 1, 'the wrong reference typed');
    w.setVerifier('FAIL', 1, [['L1', 'FAIL', 'latch_contained'], ['P1', 'FAIL', 'regular_policy_applies']]);
    assert.equal(recover(w, 'OD-RECOVERY-1', 'RECOVER notification-service OD-RECOVERY-1').status, 1, 'the topology is still unsafe');
    w.setVerifier('FAIL', 1, [['L1', 'FAIL', 'latch_contained']]);
    w.patchBroker((b) => { b.connections.push(SERVICE); });
    assert.equal(recover(w, 'OD-RECOVERY-1', 'RECOVER notification-service OD-RECOVERY-1').status, 1, 'a connection exists');
    w.patchBroker((b) => { b.connections = b.connections.filter((u) => u !== SERVICE); });
    w.setVerifierWhenInactive('FAIL', 1, [['L1', 'PASS', 'latch_inactive'], ['B1', 'FAIL', 'unexpected_binding']]);
    assert.equal(recover(w, 'OD-RECOVERY-1', 'RECOVER notification-service OD-RECOVERY-1').status, 1, 'the verification with the latch cleared does not pass');
    assert.equal(w.latchText(), LATCH_CONTAINED, 'put back to contained');
    assert.equal(w.stateOf().contained, 1);
  } finally {
    w.cleanup();
  }
});

test('recovery: with every condition met it clears the latch ONLY (no grant), resets the state, records the reference; the monitor resumes', { skip: !hasScript && 'util-linux script(1) is not available' }, () => {
  const w = containedWorld();
  try {
    w.setVerifier('FAIL', 1, [['L1', 'FAIL', 'latch_contained'], ['Q1', 'PASS', 'queue_as_declared_no_policy']]);
    w.setVerifierWhenInactive('PASS', 0);
    const grantsBefore = JSON.stringify(w.broker().perms);
    const r = recover(w, 'OD-RECOVERY-1', 'RECOVER notification-service OD-RECOVERY-1');
    assert.equal(r.status, 0, r.stdout);
    assert.equal(w.latchText(), LATCH_INACTIVE);
    assert.deepEqual([w.stateOf().contained, w.stateOf().streak], [0, 0]);
    assert.equal(JSON.stringify(w.broker().perms), grantsBefore, 'it granted nothing');
    assert.ok(!w.broker().calls.some((c) => /^set_/.test(c.sub)), 'no set_permissions or set_topic_permissions');
    assert.equal(w.records('evidence.jsonl').at(-1).authorization, 'OD-RECOVERY-1');
    assert.match(r.stdout, /holds NO grant/);
    assert.equal(monitor(w).status, 0, 'the monitor resumes on the cleared latch (pre-grant: no grant)');
  } finally {
    w.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------ installation and its verification

const installWorld = () => {
  const w = world({ installed: false, latch: null, scripts: [] });
  rmSync(w.latchDir, { recursive: true });
  const src = join(w.base, 'src', 'infra', 'rabbitmq');
  mkdirSync(join(src, 'topology-monitor'), { recursive: true });
  for (const f of readdirSync(SRC)) cpSync(join(SRC, f), join(src, 'topology-monitor', f));
  cpSync(join(ROOT, 'infra/rabbitmq/verify-topology.sh'), join(src, 'verify-topology.sh'));
  rmSync(w.install, { recursive: true });
  const units = join(w.base, 'units');
  mkdirSync(units);
  const uid = process.getuid();
  const gid = process.getgid();
  const installer = join(src, 'topology-monitor', 'install-topology-monitor.sh');
  writeFileSync(installer, variant(readFileSync(installer, 'utf8'), { INSTALL_DIR: w.install, STATE_DIR: w.state, LATCH: w.latch, UNIT_DIR: units, RUN_AS_UID: uid, OWNER: `${uid}:${gid}` }));
  const checker = join(w.base, 'verify-topology-monitor-install.sh');
  writeFileSync(checker, variant(readFileSync(join(SRC, 'verify-topology-monitor-install.sh'), 'utf8'), { INSTALL_DIR: w.install, STATE_DIR: w.state, LATCH: w.latch, UNIT_DIR: units, OWNER_UID: uid, OWNER_GID: gid, RUN_AS_UID: uid, TRUST_ROOT: w.base }), { mode: 0o755 });
  chmodSync(installer, 0o755);
  w.units = units;
  w.installer = () => spawnSync(installer, [], { encoding: 'utf8' });
  w.check = () => spawnSync(checker, [], { encoding: 'utf8' });
  return w;
};

test('installation: fresh only; the read-only verification passes on it and FAILS an altered hash, a weak mode, a symbolic link, a wrong owner', () => {
  const w = installWorld();
  try {
    let r = w.installer();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /NOT enabled, NOT started/);
    assert.equal(w.latchText(), LATCH_INACTIVE);
    assert.deepEqual([w.stateOf().contained, w.stateOf().streak, w.stateOf().last], [0, 0, 'NONE']);
    r = w.check();
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /RESULT: PASS/);
    // never over an existing installation (and so never over a contained latch)
    assert.equal(w.installer().status, 1);
    const entry = join(w.install, 'verify-and-contain.sh');
    chmodSync(entry, 0o755);
    writeFileSync(entry, `${readFileSync(entry, 'utf8')}\n# altered\n`);
    chmodSync(entry, 0o555);
    r = w.check();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL {2}sha256: .*verify-and-contain\.sh/);
    chmodSync(join(w.units, 'nawara-core-topology-monitor.timer'), 0o664);
    assert.match(w.check().stdout, /FAIL {2}mode: .*nawara-core-topology-monitor\.timer/);
    rmSync(join(w.install, 'topology-trigger.sh'));
    symlinkSync('/bin/true', join(w.install, 'topology-trigger.sh'));
    assert.match(w.check().stdout, /FAIL {2}mode: .*topology-trigger\.sh/);
  } finally {
    w.cleanup();
  }
  // a wrong owner: the same tree checked against another pinned owner fails every ownership check
  const w2 = installWorld();
  try {
    assert.equal(w2.installer().status, 0);
    const checker = join(w2.base, 'verify-topology-monitor-install.sh');
    writeFileSync(checker, variant(readFileSync(checker, 'utf8'), { OWNER_UID: process.getuid() + 1 }));
    const r = spawnSync(checker, [], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL {2}mode: .*verify-and-contain\.sh must be a file/);
  } finally {
    w2.cleanup();
  }
});

test('installation never overwrites a latch (a contained one in particular) and refuses an unpinned verifier', () => {
  const w = installWorld();
  try {
    mkdirSync(w.latchDir, { mode: 0o755 });
    writeFileSync(w.latch, LATCH_CONTAINED, { mode: 0o644 });
    assert.equal(w.installer().status, 1);
    assert.equal(w.latchText(), LATCH_CONTAINED);
    assert.ok(!existsSync(w.install), 'nothing was installed');
    rmSync(w.latchDir, { recursive: true });
    const v = join(w.base, 'src', 'infra', 'rabbitmq', 'verify-topology.sh');
    writeFileSync(v, `${readFileSync(v, 'utf8')}# altered\n`);
    const r = w.installer();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match verify-and-contain\.sh's pin/);
  } finally {
    w.cleanup();
  }
});

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

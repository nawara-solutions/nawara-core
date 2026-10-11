// R3 (ADR-0063 §4 item 10; docs/architecture/core-v2-a5-r3-alert-carrier.md): the REAL infra/alerting/auth-readiness-alert.sh against
// test-only stand-ins for docker, curl and date (lib/fake-alert-tools.mjs), with the real bash, flock, timeout and coreutils. Nothing
// touches a Docker daemon, the network, a receiver or a heartbeat provider: these tests prove the carrier's logic, not a delivery to a
// real provider (that is the demonstration the design requires before any production deployment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './lib/harness.mjs';

const SCRIPT = join(ROOT, 'infra/alerting/auth-readiness-alert.sh');
const TOOLS = join(ROOT, 'scripts/deploy-tests/lib/fake-alert-tools.mjs');
const NAME = 'nawara-core-auth-service';
const ID = (c) => c.repeat(64);
const IMG = (c) => `sha256:${c.repeat(64)}`;
const REV = '0123456789abcdef0123456789abcdef01234567';
const RECEIVER_SECRET = 'Bearer receiver-secret-7f3a9c1e4d';
const HEARTBEAT_SECRET = 'hb-secret-path-5b8e2d6a0c';
const T0 = 1760000000;
const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const READY = '200 {"status":"ready"}';
const NOT_READY = (...failed) => `503 ${JSON.stringify({ status: 'unavailable', failed })}`;
const line = (msg, context, extra = {}) => `${JSON.stringify({ ts: '2026-10-11T00:00:00.000Z', level: 'warn', service: 'auth-service', msg, context, ...extra })}\n`;
const REASON = (reason, source, marker) => line(`hierarchy_authority_not_ready reason=${reason} source=${source} marker=${marker}`, 'HierarchyAuthorityReadiness');
const REGISTRY = (code, extra = '') => line(`readiness_check_failed check=hierarchy_authority error=HierarchyAuthorityNotReady code=${code}${extra} — /ready answers 503 until it recovers`, 'Readiness');
const REASONS = {
  source_ahead_of_marker: ['organization-service', 'local'],
  marker_ahead_of_source: ['local', 'org_authoritative'],
  marker_frozen: ['local', 'frozen'],
  marker_missing: ['local', 'missing'],
  marker_invalid: ['organization-service', 'invalid'],
  marker_unreadable: ['local', 'unreadable'],
};
const DIAG = (reason) => `${REASON(reason, ...REASONS[reason])}${REGISTRY(reason)}`;

/** One host: the fake tools, two protected credential files, a state directory and a boot id. */
function host(initial = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r3-alert-test-'));
  const bin = join(dir, 'bin'); const creds = join(dir, 'creds'); const stateDir = join(dir, 'state');
  mkdirSync(bin); mkdirSync(creds, { mode: 0o700 });
  for (const t of ['docker', 'curl', 'date']) {
    writeFileSync(join(bin, t), `#!/usr/bin/env bash\nexec node ${JSON.stringify(TOOLS)} ${t} "$@"\n`); chmodSync(join(bin, t), 0o755);
  }
  const receiver = join(creds, 'receiver.curl'); const heartbeat = join(creds, 'heartbeat.curl');
  writeFileSync(receiver, `url = "https://alerts.example.test/hook-receiver"\nheader = "Authorization: ${RECEIVER_SECRET}"\n`, { mode: 0o600 });
  writeFileSync(heartbeat, `url = "https://heartbeat.example.test/ping/${HEARTBEAT_SECRET}"\n`, { mode: 0o600 });
  const bootFile = join(dir, 'boot_id'); writeFileSync(bootFile, '1b4e28ba-2fa1-11d2-883f-0016d3cca427\n');
  const stateFile = join(dir, 'fake.json');
  writeFileSync(stateFile, JSON.stringify({
    containerName: NAME, container: { id: ID('a'), running: true, image: IMG('1'), revision: REV },
    repoDigests: [`ghcr.io/nawara-solutions/nawara-core-auth-service@${IMG('2')}`], now: T0, probe: READY, logs: '', ...initial,
  }));
  const fake = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const set = (patch) => { const s = { ...fake(), ...patch }; for (const k of ['probeCalls', 'logsCalls', 'receiverFailCalls', 'logsFailCalls']) delete s[k]; writeFileSync(stateFile, JSON.stringify(s)); };
  const tick = (sec) => set({ now: fake().now + sec });
  const run = (env = {}) => {
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: {
      PATH: `${bin}:${process.env.PATH}`, FAKE_ALERT_STATE: stateFile, RECEIVER_CONFIG: receiver, HEARTBEAT_CONFIG: heartbeat,
      STATE_DIRECTORY: stateDir, ALERT_HOST_LABEL: 'prod-host-1', BOOT_ID_FILE: bootFile, ...env } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const delivered = () => fake().delivered ?? [];
  const kinds = () => delivered().map((m) => m.kind);
  const queue = () => (existsSync(join(stateDir, 'queue')) ? readdirSync(join(stateDir, 'queue')) : []);
  const stored = () => Object.fromEntries(readFileSync(join(stateDir, 'state'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { dir, stateDir, receiver, heartbeat, bootFile, fake, set, tick, run, delivered, kinds, queue, stored };
}
/** A host already past its first cycle (CARRIER_STARTED delivered), in a ready state. */
function started(initial = {}) {
  const h = host(initial);
  const r = h.run(); assert.equal(r.code, 0, r.out);
  assert.deepEqual(h.kinds(), ['CARRIER_STARTED']);
  return h;
}
const last = (h) => h.delivered().at(-1);
const PAYLOAD_KEYS = new Set(['kind', 'severity', 'service', 'host', 'container', 'image', 'index_digest', 'revision', 'state', 'failed', 'reason',
  'source', 'marker', 'registry_code', 'probe_failure', 'previous', 'previous_image', 'previous_revision', 'since', 'duration_s', 'created_at', 'runbook']);
function noLeak(h, out = '') {
  const s = h.fake();
  const everything = [out, JSON.stringify(s.dockerCalls ?? []), JSON.stringify((s.curlCalls ?? []).map((c) => [c.argv, c.env, c.payload])),
    JSON.stringify(s.delivered ?? []), existsSync(join(h.stateDir, 'state')) ? readFileSync(join(h.stateDir, 'state'), 'utf8') : ''].join('\n');
  for (const secret of [RECEIVER_SECRET, HEARTBEAT_SECRET, 'hook-receiver', 'heartbeat.example.test']) assert.ok(!everything.includes(secret), `no credential or secret URL leaks (${secret})`);
  for (const c of s.curlCalls ?? []) assert.deepEqual(c.env, [], 'no credential-bearing variable in curl\'s environment');
  for (const m of s.delivered ?? []) for (const k of Object.keys(m)) assert.ok(PAYLOAD_KEYS.has(k), `payload field ${k} is allow-listed`);
}

// ------------------------------------------------------------------------------------------------ ready, start, heartbeat
test('R3: a first cycle announces CARRIER_STARTED (ready), checks in once; a second ready cycle sends nothing but checks in again', () => {
  const h = host();
  let r = h.run();
  assert.equal(r.code, 0, r.out);
  const m = last(h);
  assert.equal(m.kind, 'CARRIER_STARTED'); assert.equal(m.severity, 'info'); assert.equal(m.state, 'ready');
  assert.equal(m.host, 'prod-host-1'); assert.equal(m.container, NAME);
  assert.equal(m.image, IMG('1')); assert.equal(m.index_digest, IMG('2')); assert.equal(m.revision, REV, 'image ID, index digest and revision are separate (L-1)');
  assert.equal(h.fake().heartbeats, 1);
  h.tick(60); r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(h.delivered().length, 1, 'nothing new when nothing changed');
  assert.equal(h.fake().heartbeats, 2);
  assert.match(r.out, /cycle state=ready failed=none probe_failure=none reason=none queued=0 delivered=0 pending=0 heartbeat=sent/);
  noLeak(h, r.out);
});

// ------------------------------------------------------------------------------------------------ C1: every authority reason
for (const reason of Object.keys(REASONS)) {
  test(`R3 C1: ${reason}: ALERT (critical) with the exact reason, source, marker and registry code`, () => {
    const h = started();
    h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG(reason) }); h.tick(60);
    const r = h.run();
    assert.equal(r.code, 0, r.out);
    const m = last(h);
    assert.equal(m.kind, 'ALERT'); assert.equal(m.severity, 'critical'); assert.equal(m.state, 'not_ready');
    assert.deepEqual(m.failed, ['hierarchy_authority']);
    assert.equal(m.reason, reason); assert.equal(m.source, REASONS[reason][0]); assert.equal(m.marker, REASONS[reason][1]);
    assert.equal(m.registry_code, reason); assert.equal(m.previous, 'ready');
    noLeak(h, r.out);
  });
}

test('R3 C1 / L-2: the reason is carried forward into a REMINDER and across a reboot (new boot id); no "unknown", no false CHANGED', () => {
  const h = started();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_frozen') }); h.tick(60); h.run();
  h.set({ logs: '' }); h.tick(3600); let r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(last(h).kind, 'REMINDER'); assert.equal(last(h).reason, 'marker_frozen'); assert.equal(last(h).registry_code, 'marker_frozen');
  writeFileSync(h.bootFile, '2c5f39cb-3fb2-12e3-994f-0127e4ddb538\n'); h.tick(60); r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(h.kinds().slice(-1), ['CARRIER_STARTED'], 'a reboot is visible; the unchanged failure is not re-alerted');
  assert.equal(last(h).reason, 'marker_frozen');
  assert.equal(h.stored().reason, 'marker_frozen');
});

// ------------------------------------------------------------------------------------------------ C2: other failures, registry formats
for (const [label, failed, logs, expect] of [
  ['database, migrations and hierarchy_authority (no recognized reason yet)', ['database', 'hierarchy_authority', 'migrations'], '', { reason: 'unknown' }],
  ['migrations only', ['migrations'], '', { reason: undefined }],
  ['shutting_down (a deployment draining)', ['shutting_down'], '', { reason: undefined }],
  ['a registry line without a code', ['hierarchy_authority'], line('readiness_check_failed check=hierarchy_authority error=ReadinessCheckTimeout — /ready answers 503 until it recovers', 'Readiness'), { reason: 'unknown', registry_code: undefined }],
  ['a registry line with a kind', ['hierarchy_authority'], `${REASON('marker_unreadable', 'local', 'unreadable')}${REGISTRY('marker_unreadable', ' kind=db_unavailable')}`, { reason: 'marker_unreadable', registry_code: 'marker_unreadable' }],
]) {
  test(`R3 C2: ${label}: ALERT with the failing set`, () => {
    const h = started();
    h.set({ probe: NOT_READY(...failed), logs }); h.tick(60);
    const r = h.run();
    assert.equal(r.code, 0, r.out);
    const m = last(h);
    assert.equal(m.kind, 'ALERT'); assert.equal(m.severity, 'critical'); assert.deepEqual(m.failed, failed);
    assert.equal(m.reason, expect.reason);
    if ('registry_code' in expect) assert.equal(m.registry_code, expect.registry_code);
    if (!failed.includes('hierarchy_authority')) assert.ok(!('source' in m) && !('marker' in m), 'no authority fields when that check passes');
  });
}

// ------------------------------------------------------------------------------------------------ C3: probe failures
for (const [label, patch, cls] of [
  ['the container does not exist', { container: null }, 'container'],
  ['the container is stopped', { container: { id: ID('a'), running: false, image: IMG('1'), revision: REV } }, 'container'],
  ['docker exec fails (Auth unreachable)', { probe: '__exit1' }, 'unreachable'],
  ['the in-container fetch cannot connect', { probe: 'unreachable' }, 'unreachable'],
  ['the probe is killed by its timeout', { probe: '__exit124' }, 'timeout'],
  ['the in-container fetch times out', { probe: 'timeout' }, 'timeout'],
  ['the /ready body is not a kit shape', { probe: '503 {"status":"unavailable","failed":["Not A Check"]}' }, 'unparseable'],
  ['the status is unexpected', { probe: '500 {"status":"ready"}' }, 'unparseable'],
]) {
  test(`R3 C3: ${label}: ALERT probe_failed:${cls}`, () => {
    const h = started();
    h.set(patch); h.tick(60);
    const r = h.run();
    assert.equal(r.code, 0, r.out);
    assert.equal(last(h).kind, 'ALERT'); assert.equal(last(h).state, 'probe_failed'); assert.equal(last(h).probe_failure, cls);
    assert.deepEqual(last(h).failed, []);
    noLeak(h, r.out);
  });
}

// ------------------------------------------------------------------------------------------------ C4, C5, C6: lifecycle
test('R3 C4: one ALERT per transition; nothing for an unchanged probe; CHANGED on a new failing set and on a new reason', () => {
  const h = started();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('source_ahead_of_marker') }); h.tick(60); h.run();
  h.set({ logs: '' }); h.tick(60); h.run(); h.tick(60); h.run();
  assert.deepEqual(h.kinds(), ['CARRIER_STARTED', 'ALERT'], 'duplicates are suppressed: an unchanged failure sends nothing');
  h.set({ probe: NOT_READY('hierarchy_authority', 'migrations') }); h.tick(60); h.run();
  assert.equal(last(h).kind, 'CHANGED'); assert.equal(last(h).previous, 'not_ready'); assert.equal(last(h).reason, 'source_ahead_of_marker');
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_frozen') }); h.tick(60); h.run();
  assert.equal(last(h).kind, 'CHANGED'); assert.equal(last(h).reason, 'marker_frozen');
  assert.equal(h.kinds().length, 4);
});

test('R3 C5: reminders are bounded: none before the interval, exactly one at it, none just after', () => {
  const h = started();
  h.set({ probe: NOT_READY('database', 'hierarchy_authority', 'migrations') }); h.tick(60); h.run();
  h.tick(3599); h.run();
  assert.deepEqual(h.kinds(), ['CARRIER_STARTED', 'ALERT']);
  h.tick(1); h.run();
  assert.equal(last(h).kind, 'REMINDER'); assert.equal(last(h).duration_s, 3600);
  h.tick(60); h.run();
  assert.deepEqual(h.kinds(), ['CARRIER_STARTED', 'ALERT', 'REMINDER']);
  noLeak(h);
});

test('R3 C6: one RECOVERED with the incident duration; never on ready→ready; never during a transport failure', () => {
  const h = started();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_missing') }); h.tick(60); h.run();
  h.set({ probe: '__exit1', logs: '' }); h.tick(60); h.run();
  assert.equal(last(h).kind, 'CHANGED', 'an unreachable probe is a change of failure, not a recovery');
  assert.equal(last(h).probe_failure, 'unreachable');
  h.set({ probe: READY }); h.tick(120); h.run();
  assert.equal(last(h).kind, 'RECOVERED'); assert.equal(last(h).previous, 'probe_failed'); assert.equal(last(h).duration_s, 180);
  assert.equal(last(h).severity, 'info');
  h.tick(60); h.run(); h.tick(60); h.run();
  assert.deepEqual(h.kinds(), ['CARRIER_STARTED', 'ALERT', 'CHANGED', 'RECOVERED']);
  noLeak(h);
});

// ------------------------------------------------------------------------------------------------ C7: durable state and the cursor
test('R3 C7 / L-2: the state persists every carried item; the log cursor is the previous cycle\'s probe start, across a reboot', () => {
  const h = started();
  assert.deepEqual(h.fake().logSince, ['15m'], 'a first cycle reads a bounded window');
  const t1 = h.fake().now;
  h.tick(60); h.run();
  assert.equal(h.fake().logSince.at(-1), iso(t1), 'the second cycle reads from the first cycle\'s probe start');
  const t2 = h.fake().now;
  writeFileSync(h.bootFile, '2c5f39cb-3fb2-12e3-994f-0127e4ddb538\n'); h.tick(60); h.run();
  assert.equal(h.fake().logSince.at(-1), iso(t2), 'the cursor survives a restart of the host');
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_invalid') }); h.tick(60); h.run();
  const s = h.stored();
  for (const k of ['state', 'failed', 'probe_failure', 'reason', 'source', 'marker', 'registry_code', 'diag_container', 'container_id', 'image', 'index_digest',
    'revision', 'since', 'last_message_at', 'cursor', 'boot_id', 'seq']) assert.ok(k in s, `state keeps ${k}`);
  assert.equal(s.state, 'not_ready'); assert.equal(s.failed, 'hierarchy_authority'); assert.equal(s.reason, 'marker_invalid'); assert.equal(s.registry_code, 'marker_invalid');
  assert.equal(s.image, IMG('1')); assert.equal(s.index_digest, IMG('2')); assert.equal(s.revision, REV); assert.equal(s.cursor, iso(h.fake().now));
});

test('R3 C7: a corrupt state file is "unknown", never assumed ready: CARRIER_STARTED, then an ALERT for the current failure', () => {
  const h = started();
  writeFileSync(join(h.stateDir, 'state'), 'state=ready\ninjected=$(touch /tmp/x)\n');
  h.set({ probe: NOT_READY('migrations') }); h.tick(60);
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /the state file is unreadable or invalid: treated as unknown/);
  assert.deepEqual(h.kinds().slice(-2), ['CARRIER_STARTED', 'ALERT']);
});

// ------------------------------------------------------------------------------------------------ C8, C9: delivery and the heartbeat
test('R3 C8: a receiver failure keeps the message queued (exit 3, heartbeat withheld); later messages wait; delivery resumes in order', () => {
  const h = started();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_ahead_of_source'), receiverFail: true }); h.tick(60);
  let r = h.run();
  assert.equal(r.code, 3, r.out); assert.match(r.out, /pending=1 heartbeat=withheld/);
  assert.equal(h.queue().length, 1); assert.equal(h.fake().heartbeats, 1);
  h.set({ probe: NOT_READY('hierarchy_authority', 'migrations'), logs: '' }); h.tick(60);
  r = h.run();
  assert.equal(r.code, 3, r.out); assert.equal(h.queue().length, 2, 'a pending alert is never discarded');
  h.set({ receiverFail: false }); h.tick(60);
  r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(h.kinds(), ['CARRIER_STARTED', 'ALERT', 'CHANGED'], 'delivered oldest first');
  assert.equal(h.queue().length, 0); assert.equal(h.fake().heartbeats, 2, 'the heartbeat resumes only once everything is delivered');
  noLeak(h, r.out);
});

test('R3 C9: a heartbeat failure fails the cycle (exit 4) without losing anything; it never carries a payload', () => {
  const h = started();
  h.set({ heartbeatFail: true }); h.tick(60);
  const r = h.run();
  assert.equal(r.code, 4, r.out); assert.match(r.out, /heartbeat=failed/);
  for (const c of h.fake().curlCalls.filter((x) => x.which === 'heartbeat')) {
    assert.equal(c.payload, null, 'no payload'); assert.ok(!c.argv.some((a) => a.startsWith('@') || a === '--data-binary'));
  }
});

test('R3 C9: a carrier that cannot run (a state directory it cannot write) fails and never checks in', () => {
  const h = host();
  mkdirSync(h.stateDir); chmodSync(h.stateDir, 0o500);
  const r = h.run();
  chmodSync(h.stateDir, 0o700);
  assert.notEqual(r.code, 0, r.out);
  assert.equal(h.fake().heartbeats ?? 0, 0, 'a broken carrier is silent towards the heartbeat, so the external switch fires');
});

for (const [label, prepare, reason] of [
  ['a receiver credential readable by others', (h) => chmodSync(h.receiver, 0o644), /readable by others/],
  ['a heartbeat credential that is a symlink', (h) => { const t = `${h.heartbeat}.real`; writeFileSync(t, 'url = "x"\n', { mode: 0o600 }); rmSync(h.heartbeat); symlinkSync(t, h.heartbeat); }, /missing or not a regular file/],
  ['an invalid host label', null, /ALERT_HOST_LABEL must be a short token/],
]) {
  test(`R3: refused before probing: ${label}; nothing is sent, no heartbeat`, () => {
    const h = host();
    if (prepare) prepare(h);
    const r = prepare ? h.run() : h.run({ ALERT_HOST_LABEL: 'bad label; rm -rf /' });
    assert.equal(r.code, 1, r.out); assert.match(r.out, reason);
    assert.equal((h.fake().dockerCalls ?? []).length, 0); assert.equal((h.fake().curlCalls ?? []).length, 0);
  });
}

// ------------------------------------------------------------------------------------------------ C10: deployments
test('R3 C10: a redeploy is alerted, not suppressed: shutting_down → container gone → new image ready (DEPLOYMENT + RECOVERED)', () => {
  const h = started();
  h.set({ probe: NOT_READY('shutting_down') }); h.tick(60); h.run();
  h.set({ container: null }); h.tick(60); h.run();
  h.set({ container: { id: ID('b'), running: true, image: IMG('3') }, repoDigests: [], probe: READY }); h.tick(60); h.run();
  assert.deepEqual(h.kinds(), ['CARRIER_STARTED', 'ALERT', 'CHANGED', 'DEPLOYMENT', 'RECOVERED']);
  const d = h.delivered()[3];
  assert.equal(d.previous_image, IMG('1')); assert.equal(d.previous_revision, REV);
  assert.equal(d.image, IMG('3')); assert.equal(d.revision, 'unlabelled'); assert.equal(d.index_digest, 'none');
  noLeak(h);
});

test('R3: the carried reason is cleared once Auth is ready: a later failure whose reason line is lost reads "unknown", never a stale reason', () => {
  const h = started();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_frozen') }); h.tick(60); h.run();
  h.set({ probe: READY, logs: '' }); h.tick(60); h.run();
  assert.equal(h.stored().reason, '', 'nothing is carried past a ready result');
  h.set({ probe: NOT_READY('hierarchy_authority') }); h.tick(60); h.run();
  assert.equal(last(h).kind, 'ALERT'); assert.equal(last(h).reason, 'unknown');
});

test('R3: a failed log read keeps the cursor, so the same window is read again and a reason written meanwhile is not lost', () => {
  const h = started();
  const cursor = h.stored().cursor;
  h.set({ probe: NOT_READY('hierarchy_authority'), logsFail: true }); h.tick(60); h.run();
  assert.equal(last(h).reason, 'unknown'); assert.equal(h.stored().cursor, cursor, 'the cursor did not advance over an unread window');
  h.set({ logsFail: false, logs: DIAG('marker_missing') }); h.tick(60); h.run();
  assert.equal(h.fake().logSince.at(-1), cursor, 'the unread window is read again');
  assert.equal(last(h).kind, 'CHANGED'); assert.equal(last(h).reason, 'marker_missing');
});

test('R3: a reason that follows an older registry line is accepted (the registry logs only on a flip); one contradicted by a later registry line is not', () => {
  const h = started();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: `${REASON('marker_unreadable', 'local', 'unreadable')}${REGISTRY('marker_unreadable')}${REASON('marker_frozen', 'local', 'frozen')}` });
  h.tick(60); h.run();
  assert.equal(last(h).reason, 'marker_frozen', 'the newer reason line wins over the earlier registry line');
  assert.equal(last(h).registry_code, 'marker_unreadable', 'the registry code is reported as logged');
});

test('R3: a stray file in the queue directory is ignored, never parsed or sent, and does not stop the cycle', () => {
  const h = started();
  writeFileSync(join(h.stateDir, 'queue', 'notes.json'), 'not a message');
  writeFileSync(join(h.stateDir, 'queue', '99999999999999999999-ALERT.json'), '{}');
  h.set({ probe: NOT_READY('migrations') }); h.tick(60);
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(last(h).kind, 'ALERT'); assert.equal(h.kinds().length, 2);
});

test('R3 C10: a new container resets the carried reason; the persisting failure then reads "unknown" without a false CHANGED', () => {
  const h = started();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_frozen') }); h.tick(60); h.run();
  h.set({ container: { id: ID('c'), running: true, image: IMG('1'), revision: REV }, logs: '' }); h.tick(60); h.run();
  assert.deepEqual(h.kinds(), ['CARRIER_STARTED', 'ALERT'], 'same image, same failure: no message');
  assert.equal(h.stored().reason, '', 'nothing is carried from another container');
});

// ------------------------------------------------------------------------------------------------ C11: secrets
test('R3 C11: credentials reach curl only through --config; never in argv, curl\'s environment, output, state or any payload', () => {
  const h = started();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_unreadable') }); h.tick(60);
  const r = h.run();
  for (const c of h.fake().curlCalls) {
    assert.equal(c.argv[0], '-q', 'no ~/.curlrc is read'); assert.ok(c.argv.includes('--config'));
    assert.ok(c.argv.includes('--proto') && c.argv.includes('=https'), 'HTTPS only');
  }
  noLeak(h, r.out);
});

// ------------------------------------------------------------------------------------------------ C12: spoofed and malformed logs
for (const [label, logs] of [
  ['the reason inside another field', line('innocent', 'Other', { note: 'hierarchy_authority_not_ready reason=marker_frozen source=local marker=frozen' })],
  ['a nested msg', `${JSON.stringify({ ts: '2026-10-11T00:00:00.000Z', level: 'warn', service: 'auth-service', msg: 'x', context: 'Y', inner: { msg: 'hierarchy_authority_not_ready reason=marker_frozen source=local marker=frozen' } })}\n`],
  ['the wrong context', line('hierarchy_authority_not_ready reason=marker_frozen source=local marker=frozen', 'SomethingElse')],
  ['another service', JSON.stringify({ ts: '2026-10-11T00:00:00.000Z', level: 'warn', service: 'organization-service', msg: 'hierarchy_authority_not_ready reason=marker_frozen source=local marker=frozen', context: 'HierarchyAuthorityReadiness' }) + '\n'],
  ['plain text', 'hierarchy_authority_not_ready reason=marker_frozen source=local marker=frozen\n'],
  ['a reason outside the enumeration', line('hierarchy_authority_not_ready reason=marker_bogus source=local marker=frozen', 'HierarchyAuthorityReadiness')],
  ['a reason disagreeing with the registry code', `${REASON('marker_frozen', 'local', 'frozen')}${REGISTRY('marker_missing')}`],
  ['an oversized line', line(`hierarchy_authority_not_ready reason=marker_frozen source=local marker=frozen`, 'HierarchyAuthorityReadiness', { pad: 'x'.repeat(3000) })],
]) {
  test(`R3 C12: spoofed or malformed diagnostics are not accepted: ${label} (reason stays unknown; nothing echoed)`, () => {
    const h = started();
    h.set({ probe: NOT_READY('hierarchy_authority'), logs }); h.tick(60);
    const r = h.run();
    assert.equal(r.code, 0, r.out);
    assert.equal(last(h).reason, 'unknown');
    assert.ok(!JSON.stringify(h.delivered()).includes('marker_bogus') && !JSON.stringify(h.delivered()).includes('innocent'));
    noLeak(h, r.out);
  });
}

// ------------------------------------------------------------------------------------------------ C13, C14
test('R3 C13: no suppression in G6/F6 windows: source_ahead_of_marker alerts whatever window or marker file is present', () => {
  const h = started();
  for (const f of ['authorized-window', 'maintenance', 'suppress']) writeFileSync(join(h.stateDir, f), 'yes\n');
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('source_ahead_of_marker') }); h.tick(60);
  const r = h.run({ AUTHORIZED_WINDOW: 'yes', SUPPRESS_ALERTS: 'yes' });
  assert.equal(r.code, 0, r.out);
  assert.equal(last(h).kind, 'ALERT'); assert.equal(last(h).severity, 'critical'); assert.equal(last(h).reason, 'source_ahead_of_marker');
});

test('R3 C14: read-only: only inspect, image inspect, logs and one exec that reads /ready are ever run', () => {
  const h = started();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_frozen') }); h.tick(60); h.run();
  h.set({ container: null }); h.tick(60); h.run();
  for (const a of h.fake().dockerCalls) {
    assert.ok(['logs', 'exec'].includes(a[0]) || (['container', 'image'].includes(a[0]) && a[1] === 'inspect'), `allowed docker command: ${a[0]} ${a[1]}`);
    if (a[0] === 'exec') { assert.equal(a[1], NAME); assert.equal(a[2], 'node'); assert.equal(a[3], '-e'); assert.match(a[4], /fetch\('http:\/\/127\.0\.0\.1:3000\/ready'/); assert.match(a[4], /clearTimeout\(t\)/, 'the in-container probe exits as soon as it has its answer'); assert.doesNotMatch(a[4], /auth\/health/); }
  }
});

// ------------------------------------------------------------------------------------------------ concurrency
test('R3: a cycle that finds another one running does nothing (no probe, no message, no heartbeat) and exits 0', async () => {
  const h = started();
  const holder = spawn('flock', [join(h.stateDir, 'lock'), 'sleep', '3']);
  await new Promise((r) => setTimeout(r, 300));
  const before = h.fake();
  h.tick(60);
  const r = h.run();
  holder.kill();
  assert.equal(r.code, 0, r.out); assert.match(r.out, /another cycle is running; this one does nothing/);
  assert.equal(h.fake().dockerCalls.length, before.dockerCalls.length); assert.equal(h.fake().heartbeats, before.heartbeats);
});

// ------------------------------------------------------------------------------------------------ the units (static)
test('R3: the unit never pulls Docker in (ordering only), runs one bounded cycle, and takes its credentials from systemd', () => {
  const unit = readFileSync(join(ROOT, 'infra/alerting/auth-readiness-alert.service'), 'utf8').split('\n').filter((l) => !l.startsWith('#'));
  const has = (re) => unit.some((l) => re.test(l));
  assert.ok(has(/^After=.*\bdocker\.service\b/), 'ordered after Docker');
  assert.ok(!has(/^(Requires|Wants|BindsTo|PartOf|Upholds|Requisite)=.*docker/), 'a stopped Docker daemon is never started by the carrier');
  assert.ok(has(/^Type=oneshot$/) && has(/^TimeoutStartSec=55$/), 'one bounded cycle');
  assert.ok(has(/^LoadCredential=receiver\.curl:/) && has(/^LoadCredential=heartbeat\.curl:/) && has(/^Environment=RECEIVER_CONFIG=%d\/receiver\.curl$/));
  assert.ok(!unit.some((l) => /^Environment=.*(https?:|Bearer|token|secret)/i.test(l)), 'no destination or credential in the unit');
  for (const o of ['NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'ProtectSystem=strict', 'StateDirectory=nawara-auth-readiness-alert']) assert.ok(unit.includes(o), o);
  const timer = readFileSync(join(ROOT, 'infra/alerting/auth-readiness-alert.timer'), 'utf8');
  assert.match(timer, /^OnUnitActiveSec=60$/m); assert.match(timer, /^OnBootSec=60$/m);
});

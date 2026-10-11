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
  const set = (patch) => { const s = { ...fake(), ...patch }; for (const k of ['probeCalls', 'logsCalls', 'receiverFailCalls', 'logsFailCalls', 'pushoverRespCalls', 'hcRespCalls']) delete s[k]; writeFileSync(stateFile, JSON.stringify(s)); };
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
  assert.ok(has(/^Environment=RECEIVER_KIND=pushover$/) && has(/^Environment=HEARTBEAT_KIND=healthchecks$/), 'the selected providers');
  for (const c of ['pushover.token', 'pushover.user', 'healthchecks.url']) assert.ok(has(new RegExp(`^LoadCredential=${c.replace('.', '\\.')}:/etc/nawara-auth-readiness-alert/`)), c);
  assert.ok(has(/^Environment=PUSHOVER_TOKEN_FILE=%d\/pushover\.token$/) && has(/^Environment=HEALTHCHECKS_PING_URL_FILE=%d\/healthchecks\.url$/));
  assert.ok(!unit.some((l) => /^Environment=/.test(l) && !/^Environment=[A-Z_]+_FILE=%d\/[a-z.]+$/.test(l) && /(https?:|Bearer|token|secret|user)/i.test(l)),
    'no destination or credential in the unit (only paths into the credentials directory)');
  for (const o of ['NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'ProtectSystem=strict', 'StateDirectory=nawara-auth-readiness-alert']) assert.ok(unit.includes(o), o);
  const timer = readFileSync(join(ROOT, 'infra/alerting/auth-readiness-alert.timer'), 'utf8');
  assert.match(timer, /^OnUnitActiveSec=60$/m); assert.match(timer, /^OnBootSec=60$/m);
});

// ================================================================================================ the selected providers
// Pushover (receiver) and Healthchecks.io (heartbeat), reached with `curl --config -`: the URL and the secrets on stdin, never in argv.
// Fake credentials only: obviously synthetic values with the documented shapes; no real account, message or ping is involved.
const PO_TOKEN = 'FAKEPUSHOVERAPPTOKEN'.padEnd(30, '0');
const PO_USER = 'FAKEPUSHOVERUSERKEY'.padEnd(30, '1');
const HC_URL = 'https://hc-ping.com/0f0f0f0f-1e1e-4d4d-8c8c-fa4efa4efa4e';
const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';
const PO_OK = { code: 200, body: '{"status":1,"request":"fake-request-1"}' };

function providerHost(initial = {}, files = {}) {
  const h = host(initial);
  const creds = join(h.dir, 'creds');
  const write = (name, value) => { const p = join(creds, name); writeFileSync(p, value, { mode: 0o600 }); return p; };
  const tokenFile = write('pushover.token', files.token ?? `${PO_TOKEN}\n`);
  const userFile = write('pushover.user', files.user ?? `${PO_USER}\n`);
  const hcFile = write('healthchecks.url', files.hc ?? `${HC_URL}\n`);
  const run = (env = {}) => h.run({ RECEIVER_KIND: 'pushover', HEARTBEAT_KIND: 'healthchecks', PUSHOVER_TOKEN_FILE: tokenFile, PUSHOVER_USER_FILE: userFile,
    HEALTHCHECKS_PING_URL_FILE: hcFile, RECEIVER_CONFIG: '', HEARTBEAT_CONFIG: '', ...env });
  const pushed = () => h.fake().pushed ?? [];
  const calls = (which) => (h.fake().providerCalls ?? []).filter((c) => c.which === which);
  const titles = () => pushed().map((f) => f.title);
  return { ...h, run, pushed, calls, titles, tokenFile, hcFile };
}
/** A provider host past its first, fully delivered cycle; `then` (e.g. a failing Pushover answer) applies from the next cycle on. */
function providerStarted(then = {}) {
  const h = providerHost();
  const r = h.run(); assert.equal(r.code, 0, r.out);
  assert.deepEqual(h.titles(), ['Nawara Auth readiness: CARRIER_STARTED (ready)']);
  h.set(then);
  return h;
}
function noProviderLeak(h, out = '') {
  const s = h.fake();
  const visible = [out, JSON.stringify(s.dockerCalls ?? []), JSON.stringify((s.providerCalls ?? []).map((c) => [c.argv, c.env])),
    JSON.stringify((s.pushed ?? []).map(({ token, user, ...rest }) => rest)),
    ...readdirSync(h.stateDir).filter((f) => f !== 'queue').map((f) => readFileSync(join(h.stateDir, f), 'utf8')),
    ...h.queue().map((f) => readFileSync(join(h.stateDir, 'queue', f), 'utf8'))].join('\n');
  for (const secret of [PO_TOKEN, PO_USER, HC_URL, '0f0f0f0f-1e1e-4d4d-8c8c-fa4efa4efa4e']) assert.ok(!visible.includes(secret), `no provider secret leaks (${secret.slice(0, 12)}…)`);
  for (const c of s.providerCalls ?? []) {
    assert.deepEqual(c.env, [], 'no secret-bearing variable in curl\'s environment');
    assert.equal(c.argv[0], '-q'); assert.ok(c.argv.includes('--config') && c.argv[c.argv.indexOf('--config') + 1] === '-', 'the config (URL and secrets) on stdin');
    for (const o of ['--proto', '=https', '--proto-redir', '--max-redirs', '0', '--max-time']) assert.ok(c.argv.includes(o), `curl ${o}`);
    assert.ok(!c.argv.some((a) => ['-k', '--insecure', '-L', '--location', '--fail'].includes(a)), 'TLS verification on, no redirect followed');
  }
  assert.ok(!existsSync(join(h.stateDir, 'response.tmp')), 'no provider answer is kept');
}

test('providers: an ALERT is accepted by Pushover only through the official endpoint, with the secrets on stdin; Healthchecks.io gets a bare check-in', () => {
  const h = providerStarted();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_frozen') }); h.tick(60);
  const r = h.run();
  assert.equal(r.code, 0, r.out);
  const m = h.pushed().at(-1);
  assert.equal(m.title, 'Nawara Auth readiness: ALERT (not_ready)'); assert.equal(m.priority, '1');
  assert.equal(m.token, PO_TOKEN); assert.equal(m.user, PO_USER);
  assert.match(m.message, /^host=prod-host-1\nstate=not_ready\nfailed=hierarchy_authority\nreason=marker_frozen\nsource=local\nmarker=frozen\nregistry_code=marker_frozen\nprevious=ready\n/);
  assert.match(m.message, /\nimage=sha256:1{64}\nindex_digest=sha256:2{64}\nrevision=0123456789abcdef/);
  for (const c of h.calls('pushover')) assert.equal(c.url, PUSHOVER_API);
  for (const c of h.calls('healthchecks')) { assert.equal(c.url, HC_URL); assert.deepEqual(c.stdinKeys, ['url'], 'no data, no diagnostic content'); }
  assert.equal(h.fake().pings, 2);
  assert.deepEqual((h.fake().providerCalls ?? []).filter((c) => c.which.startsWith('unexpected')), []);
  noProviderLeak(h, r.out);
});

test('providers: each kind is formatted within Pushover\'s limits; critical kinds are high priority, the others normal, never emergency', () => {
  const h = providerStarted();
  h.set({ probe: NOT_READY('hierarchy_authority'), logs: DIAG('marker_missing') }); h.tick(60); h.run();
  h.set({ probe: NOT_READY('hierarchy_authority', 'migrations'), logs: '' }); h.tick(60); h.run();
  h.tick(3600); h.run();
  h.set({ container: { id: ID('b'), running: true, image: IMG('3'), revision: REV }, probe: READY }); h.tick(60); h.run();
  const byKind = Object.fromEntries(h.pushed().map((f) => [f.title.split(': ')[1].split(' ')[0], f]));
  assert.deepEqual(Object.keys(byKind).sort(), ['ALERT', 'CARRIER_STARTED', 'CHANGED', 'DEPLOYMENT', 'RECOVERED', 'REMINDER']);
  for (const [k, f] of Object.entries(byKind)) {
    assert.equal(f.priority, ['ALERT', 'CHANGED', 'REMINDER'].includes(k) ? '1' : '0', k);
    assert.ok(f.title.length <= 250 && f.message.length <= 1024, `${k} within limits`);
  }
  assert.match(byKind.DEPLOYMENT.message, /\nprevious_image=sha256:1{64}\nprevious_revision=0123456789abcdef/);
  assert.match(byKind.RECOVERED.message, /\nprevious=not_ready\n/);
  assert.ok(!h.pushed().some((f) => f.priority === '2' || 'retry' in f || 'expire' in f));
  noProviderLeak(h);
});

for (const [label, resp, backoff, logRe] of [
  ['an API rejection despite HTTP 200 (status 0)', { code: 200, body: '{"status":0,"errors":["unexpected"],"request":"r"}' }, 900, /did not accept the message \(HTTP 200\)/],
  ['a 4xx (invalid credentials)', { code: 400, body: `{"user":"invalid","errors":["user identifier is invalid ${PO_USER}"],"status":0}` }, 3600, /refused the request \(HTTP 400; check the token and user key\)/],
  ['rate limiting (429, quota exhausted)', { code: 429, body: '{"status":0,"errors":["quota"]}' }, 3600, /quota exhausted \(429\): retrying in 3600 s/],
  ['a redirect (never followed)', { code: 302, body: '' }, 900, /did not accept the message \(HTTP 302\)/],
]) {
  test(`providers: ${label}: the message stays queued, no check-in, back off ${backoff} s, then delivered once accepted`, () => {
    const h = providerStarted({ pushoverResp: resp });
    h.set({ probe: NOT_READY('migrations') }); h.tick(60);
    let r = h.run();
    assert.equal(r.code, 3, r.out); assert.match(r.out, logRe); assert.match(r.out, /pending=1 heartbeat=withheld/);
    assert.equal(h.queue().length, 1); assert.equal(h.fake().pings, 1, 'no check-in while an alert is undelivered');
    assert.doesNotMatch(r.out, /user identifier is invalid|errors|status/, 'the provider\'s answer is never printed');
    const pushes = h.calls('pushover').length;
    h.tick(backoff - 60); r = h.run();
    assert.equal(h.calls('pushover').length, pushes, 'no retry before the back-off ends'); assert.match(r.out, /backing off until/);
    h.set({ pushoverResp: PO_OK }); h.tick(60); r = h.run();
    assert.equal(r.code, 0, r.out); assert.equal(h.queue().length, 0);
    // After an hour's back-off the failure has also earned its REMINDER: both delivered, oldest first.
    assert.deepEqual(h.titles().slice(1), ['Nawara Auth readiness: ALERT (not_ready)', ...(backoff >= 3600 ? ['Nawara Auth readiness: REMINDER (not_ready)'] : [])]);
    assert.equal(h.fake().pings, 2);
    assert.ok(!existsSync(join(h.stateDir, 'receiver-backoff')), 'the back-off ends with the first acceptance');
    noProviderLeak(h, r.out);
  });
}

for (const [label, resp] of [
  ['a network failure', { code: 0, body: '', exit: 7 }],
  ['a timeout', { code: 0, body: '', exit: 28 }],
  ['a server error (5xx)', { code: 503, body: 'unavailable' }],
]) {
  test(`providers: ${label}: queued and retried on the very next cycle (no back-off)`, () => {
    const h = providerStarted({ pushoverResp: resp });
    h.set({ probe: NOT_READY('migrations') }); h.tick(60);
    let r = h.run();
    assert.equal(r.code, 3, r.out); assert.match(r.out, /unreachable or failing/);
    h.set({ pushoverResp: PO_OK }); h.tick(60); r = h.run();
    assert.equal(r.code, 0, r.out); assert.equal(h.titles().at(-1), 'Nawara Auth readiness: ALERT (not_ready)');
  });
}

test('providers: an uncertain acknowledgement (accepted, then a timeout) is sent again: delivery is at-least-once, the duplicate is identical', () => {
  const h = providerStarted({ pushoverResp: { accept: true, code: 0, body: '', exit: 28 } });
  h.set({ probe: NOT_READY('migrations') }); h.tick(60);
  assert.equal(h.run().code, 3);
  h.set({ pushoverResp: PO_OK }); h.tick(60); assert.equal(h.run().code, 0);
  const alerts = h.pushed().filter((f) => f.title.includes('ALERT'));
  assert.equal(alerts.length, 2); assert.deepEqual(alerts[0], alerts[1], 'the same message (same created_at), not a new incident');
});

test('providers: a restart with an undelivered alert keeps it first; the new CARRIER_STARTED follows it once Pushover is back', () => {
  const h = providerStarted({ pushoverResp: { code: 503, body: '' } });
  h.set({ probe: NOT_READY('migrations') }); h.tick(60); h.run();
  writeFileSync(h.bootFile, '2c5f39cb-3fb2-12e3-994f-0127e4ddb538\n'); h.tick(60); h.run();
  assert.equal(h.queue().length, 2);
  h.set({ pushoverResp: PO_OK }); h.tick(60); const r = h.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(h.titles().slice(1), ['Nawara Auth readiness: ALERT (not_ready)', 'Nawara Auth readiness: CARRIER_STARTED (not_ready)']);
});

for (const [label, resp, logRe] of [
  ['the check does not exist ("OK (not found)")', { code: 200, body: 'OK (not found)' }, /no such check/],
  ['the ping is rate limited ("OK (rate limited)")', { code: 200, body: 'OK (rate limited)' }, /rate-limited the ping/],
  ['an HTTP failure', { code: 500, body: 'error' }, /ping failed \(HTTP 500/],
  ['a timeout', { code: 0, body: '', exit: 28 }, /ping failed \(HTTP 000, curl 28\)/],
  ['a slug check that does not exist (404)', { code: 404, body: 'not found' }, /no such check/],
]) {
  test(`providers: Healthchecks.io: ${label} is NOT a check-in: the cycle fails (exit 4)`, () => {
    const h = providerHost({ hcResp: resp });
    const r = h.run();
    assert.equal(r.code, 4, r.out); assert.match(r.out, logRe); assert.match(r.out, /heartbeat=failed/);
    assert.equal(h.titles().length, 1, 'the alert itself was delivered');
    noProviderLeak(h, r.out);
  });
}

test('providers: the check-in is withheld while Pushover cannot take an alert, and resumes only after delivery', () => {
  const h = providerStarted({ pushoverResp: { code: 503, body: '' } });
  h.set({ probe: NOT_READY('migrations') });
  for (let i = 0; i < 3; i++) { h.tick(60); assert.equal(h.run().code, 3); }
  assert.equal(h.calls('healthchecks').length, 1, 'only the first, fully delivered cycle checked in');
  h.set({ pushoverResp: PO_OK }); h.tick(60); assert.equal(h.run().code, 0);
  assert.equal(h.calls('healthchecks').length, 2);
});

test('providers: check-ins follow completed cycles only: none from a cycle skipped by the lock, none while the timer does not run', async () => {
  const h = providerStarted();
  h.tick(60); h.run(); h.tick(60); h.run();
  assert.equal(h.fake().pings, 3, 'one check-in per completed cycle');
  const holder = spawn('flock', [join(h.stateDir, 'lock'), 'sleep', '3']);
  await new Promise((r) => setTimeout(r, 300));
  h.tick(60); const r = h.run(); holder.kill();
  assert.match(r.out, /another cycle is running/); assert.equal(h.fake().pings, 3);
  // A stopped timer runs no cycle at all: the check stops receiving pings and Healthchecks.io alerts after its period and grace.
});

for (const [label, files, reason] of [
  ['a Pushover token of the wrong shape', { token: 'short-token\n' }, /does not hold a valid token \(value not shown\)/],
  ['a Pushover user key of the wrong shape', { user: `${PO_USER}x\n` }, /does not hold a valid user or group key \(value not shown\)/],
  ['a heartbeat URL on another host (spoofing)', { hc: 'https://hc-ping.example.com/0f0f0f0f-1e1e-4d4d-8c8c-fa4efa4efa4e\n' }, /does not hold a https:\/\/hc-ping\.com success URL/],
  ['a plain-HTTP heartbeat URL', { hc: 'http://hc-ping.com/0f0f0f0f-1e1e-4d4d-8c8c-fa4efa4efa4e\n' }, /does not hold a https:\/\/hc-ping\.com success URL/],
  ['a /fail heartbeat URL', { hc: `${HC_URL}/fail\n` }, /does not hold a https:\/\/hc-ping\.com success URL/],
  ['a create-on-ping heartbeat URL', { hc: 'https://hc-ping.com/abcdefghijklmnopqrstuv/auth-readiness?create=1\n' }, /does not hold a https:\/\/hc-ping\.com success URL/],
  ['a URL with embedded credentials', { hc: 'https://user:pass@hc-ping.com/0f0f0f0f-1e1e-4d4d-8c8c-fa4efa4efa4e\n' }, /does not hold a https:\/\/hc-ping\.com success URL/],
]) {
  test(`providers: refused before probing: ${label}; nothing is sent and the value is never printed`, () => {
    const h = providerHost({}, files);
    const r = h.run();
    assert.equal(r.code, 1, r.out); assert.match(r.out, reason);
    for (const v of Object.values(files)) assert.ok(!r.out.includes(v.trim()), 'the refused value is not echoed');
    assert.equal((h.fake().providerCalls ?? []).length, 0); assert.equal((h.fake().dockerCalls ?? []).length, 0);
  });
}

for (const slug of ['auth-readiness', 'auth_readiness']) {
  test(`providers: a slug-style ping URL (ping key and slug "${slug}") is accepted`, () => {
    const h = providerHost({}, { hc: `https://hc-ping.com/abcdefghijklmnopqrstuv/${slug}\n` });
    const r = h.run();
    assert.equal(r.code, 0, r.out); assert.equal(h.calls('healthchecks')[0].url, `https://hc-ping.com/abcdefghijklmnopqrstuv/${slug}`);
  });
}

test('providers: a back-off beyond the longest one (a clock stepped back, a damaged file) is ignored', () => {
  const h = providerStarted();
  writeFileSync(join(h.stateDir, 'receiver-backoff'), `${h.fake().now + 86400}\n`);
  h.set({ probe: NOT_READY('migrations') }); h.tick(60);
  const r = h.run();
  assert.equal(r.code, 0, r.out); assert.equal(h.titles().at(-1), 'Nawara Auth readiness: ALERT (not_ready)');
});

test('providers: the generic curl-config path is unchanged (the default): no stdin config, the protected files\' --config', () => {
  const h = started();
  assert.equal((h.fake().providerCalls ?? []).length, 0);
  assert.ok(h.fake().curlCalls.every((c) => c.argv.includes('--config') && c.argv[c.argv.indexOf('--config') + 1] !== '-'));
});

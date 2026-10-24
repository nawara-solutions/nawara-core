// Core V2 OD-BRK-2b-1: a disposable, unprivileged "installation" of infra/rabbitmq/topology-monitor for the deployment-script tests.
// The REAL scripts are installed with only their pinned locations (and, where a test needs it, the owner uid, the verifier pin, the
// broker CLI and the timing pins) re-pinned by `variant`, which refuses any other change: the logic under test is the reviewed logic.
// The broker is lib/fake-rabbitmqctl-docker.mjs; the verifier is a stub whose result each test sets (the real verifier and a real
// broker are certified by scripts/deploy-tests/real-broker-topology-containment.mjs).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SRC = join(ROOT, 'infra/rabbitmq/topology-monitor');
export const LATCH_INACTIVE = 'nawara-core-topology-containment v1\nservice=notification-service\nstate=inactive';
export const LATCH_CONTAINED = 'nawara-core-topology-containment v1\nservice=notification-service\nstate=contained';
export const ROLE = {
  conf: '^(nawara\\.events|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$',
  write: '^(amq\\.default|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$',
};
export const TOPIC_READ = '^(admin\\.operator_code_issued|admin\\.operator_confirmation_code_issued|admin\\.owner_login_from_new_device|admin\\.owner_recovery_completed|admin\\.owner_recovery_requested|member\\.contact_verification_requested|membership\\.approved|membership\\.rejected|membership\\.revoked)$';
const FAKE = fileURLToPath(new URL('./fake-rabbitmqctl-docker.mjs', import.meta.url));
export const sha256 = (t) => createHash('sha256').update(t).digest('hex');

/** The script with ONLY the named `readonly NAME=...` pin lines replaced; every other line is the reviewed file's. */
export function variant(text, pins) {
  let out = text;
  for (const [name, value] of Object.entries(pins)) {
    if ((out.match(new RegExp(`^readonly ${name}=`, 'gm')) ?? []).length !== 1) throw new Error(`pin ${name}: not exactly one line`);
    out = out.replace(new RegExp(`^readonly ${name}=.*$`, 'm'), `readonly ${name}=${typeof value === 'number' ? value : `'${value}'`}`);
  }
  const rest = (t) => t.split('\n').filter((l) => !Object.keys(pins).some((n) => l.startsWith(`readonly ${n}=`))).join('\n');
  if (rest(out) !== rest(text)) throw new Error('variant changed more than its pins');
  return out;
}

export const verifierLine = (result, checks = [['L1', result === 'PASS' ? 'PASS' : 'FAIL', result === 'PASS' ? 'latch_inactive' : 'latch_contained']]) =>
  `{"verifier":"verify-topology","version":1,"service":"notification-service","phase":"@PHASE@","result":"${result}","completeness":"full","checks":[${checks.map(([id, st, r]) => `{"id":"${id}","status":"${st}","reason":"${r}"}`).join(',')}],"at":"2026-10-24T00:00:00Z"}`;

const helpers = {
  writeState({ contained = 0, streak = 0, last = 'NONE', run = 0 } = {}) {
    const f = join(this.state, 'state');
    writeFileSync(f, `nawara-core-topology-monitor-state v1\nservice=notification-service\ncontained=${contained}\nunknown_streak=${streak}\nlast_result=${last}\nlast_run=${run}\n`, { mode: 0o600 });
    chmodSync(f, 0o600);
  },
  setVerifier(result, exit, checks) { writeFileSync(join(this.ctl, 'verifier'), `${exit}\n${verifierLine(result, checks)}\n`); },
  setVerifierWhenInactive(result, exit, checks) { writeFileSync(join(this.ctl, 'verifier-inactive'), `${exit}\n${verifierLine(result, checks)}\n`); },
  setVerifierRaw(exit, line) { writeFileSync(join(this.ctl, 'verifier'), `${exit}\n${line}\n`); },
  /** Installs one script of infra/rabbitmq/topology-monitor, re-pinned with the world's pins it declares (and `over`). */
  put(name, over = {}) {
    const text = readFileSync(join(SRC, name), 'utf8');
    const all = { ...this.pins, ...over };
    const own = Object.fromEntries(Object.entries(all).filter(([k]) => new RegExp(`^readonly ${k}=`, 'm').test(text)));
    const path = join(this.install, name);
    rmSync(path, { force: true });
    writeFileSync(path, variant(text, own), { mode: 0o555 });
    chmodSync(path, 0o555);
    return path;
  },
  broker() { return JSON.parse(readFileSync(this.brokerFile, 'utf8')); },
  patchBroker(fn) { const b = this.broker(); fn(b); writeFileSync(this.brokerFile, JSON.stringify(b)); },
  stateText() { const f = join(this.state, 'state'); return existsSync(f) ? readFileSync(f, 'utf8') : null; },
  stateOf() {
    const m = /\ncontained=([01])\nunknown_streak=(\d+)\nlast_result=(\w+)\nlast_run=(\d+)\n?$/.exec(this.stateText() ?? '');
    return m ? { contained: Number(m[1]), streak: Number(m[2]), last: m[3], run: Number(m[4]) } : null;
  },
  latchText() { return existsSync(this.latch) ? readFileSync(this.latch, 'utf8') : null; },
  records(name) { const f = join(this.state, name); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; },
  verifierCalls() { const f = join(this.ctl, 'verifier-calls'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; },
  cleanup() { rmSync(this.base, { recursive: true, force: true }); },
};

/**
 * A world: install/ (0755) with the re-pinned scripts and the stub verifier, state/ (0700) with the marker and a state, latch/ (0755)
 * with the latch, a fake broker and a `docker` shim first on the pinned PATH. `pins` adds per-test pins (timing, uids).
 */
export function world({ state = {}, latch = LATCH_INACTIVE, installed = true, broker = {}, pins = {}, scripts = ['verify-and-contain.sh'] } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'topology-monitor-')));
  const d = Object.assign(Object.create(helpers), { base, install: join(base, 'install'), state: join(base, 'state'), latchDir: join(base, 'latch'), shim: join(base, 'shim'), ctl: join(base, 'ctl') });
  d.latch = join(d.latchDir, 'notification-service.containment');
  for (const [p, m] of [[d.install, 0o755], [d.shim, 0o755], [d.ctl, 0o700], [d.latchDir, 0o755]]) { mkdirSync(p); chmodSync(p, m); }
  if (installed) {
    mkdirSync(d.state);
    chmodSync(d.state, 0o700);
    writeFileSync(join(d.state, 'installed'), 'nawara-core-topology-monitor installed v1 at=1700000000\n', { mode: 0o600 });
    if (state !== null) d.writeState(state);
  }
  if (latch !== null) writeFileSync(d.latch, latch, { mode: 0o644 });
  const inactive = LATCH_INACTIVE.replace(/\n/g, '\\n');
  const stub = [
    '#!/usr/bin/env bash',
    '# TEST STUB of infra/rabbitmq/verify-topology.sh: prints the result the test set (ctl/verifier), and records phase and environment names',
    'phase=$3',
    `f=${JSON.stringify(join(d.ctl, 'verifier'))}`,
    `if [ -f ${JSON.stringify(join(d.ctl, 'verifier-inactive'))} ] && [ "$(head -c 512 ${JSON.stringify(d.latch)} 2>/dev/null)" = "$(printf '${inactive}')" ]; then f=${JSON.stringify(join(d.ctl, 'verifier-inactive'))}; fi`,
    `printf '%s %s\\n' "$phase" "$(env | cut -d= -f1 | sort | tr '\\n' ' ')" >> ${JSON.stringify(join(d.ctl, 'verifier-calls'))}`,
    'code=$(head -n 1 "$f")',
    'line=$(sed -n 2p "$f")',
    'printf \'%s\\n\' "${line//@PHASE@/$phase}"',
    'exit "$code"',
    '',
  ].join('\n');
  writeFileSync(join(d.install, 'verify-topology.sh'), stub, { mode: 0o444 });
  d.setVerifier('PASS', 0);
  d.brokerFile = join(base, 'broker.json');
  writeFileSync(d.brokerFile, JSON.stringify({
    container: 'nawara-core-rabbitmq', latchPath: d.latch, calls: [],
    users: { 'notification-service': '[]', 'audit-service': '[]', 'nawara-admin': '[administrator]' },
    perms: { 'notification-service': { 'nawara-core': [ROLE.conf, ROLE.write, ROLE.conf] }, 'audit-service': { 'nawara-core': ['^a$', '^a$', '^a$'] } },
    topic: { 'notification-service': { 'nawara-core': ['nawara.events', '^(?!)$', TOPIC_READ] }, 'audit-service': { 'nawara-core': ['nawara.events', '^(?!)$', '^(audit\\.#)$'] } },
    connections: ['notification-service', 'audit-service', 'notification-service'],
    ...broker,
  }));
  writeFileSync(join(d.shim, 'docker'), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} ${JSON.stringify(d.brokerFile)} "$@"\n`, { mode: 0o755 });
  const uid = process.getuid();
  d.pins = {
    INSTALL_DIR: d.install, STATE_DIR: d.state, LATCH: d.latch, SAFE_PATH: `${d.shim}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    OWNER_UID: uid, RUN_AS_UID: uid, VERIFIER_SHA256: sha256(stub), CONFIRM_INTERVAL: 0, ...pins,
  };
  for (const s of scripts) d.put(s);
  return d;
}

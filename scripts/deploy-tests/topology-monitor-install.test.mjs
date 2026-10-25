// Core V2 OD-BRK-2b-I: the authenticated installation lifecycle (install-topology-monitor.sh) and its read-only verification
// (verify-topology-monitor-install.sh), unprivileged, in a disposable root under the test's own directory: the reviewed scripts with only
// their locations, owner, PATH and timing re-pinned (lib/topology-monitor-world.mjs `variant`), a DISPOSABLE signing key, manifests built
// with the real generator (scripts/topology-monitor-manifest.mjs), crash injection at each transaction checkpoint, and stand-ins for
// systemctl and `sshd -T`. Nothing outside the test's directory is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { ROOT, SRC, variant } from './lib/topology-monitor-world.mjs';
import { MANIFEST_ARTIFACTS, manifestOfCommit, manifestText } from '../topology-monitor-manifest.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const COMMIT = 'a'.repeat(40);
const LATCH_CONTAINED = 'nawara-core-topology-containment v1\nservice=notification-service\nstate=contained';
const UNITS = MANIFEST_ARTIFACTS.map(([n]) => n).filter((n) => /\.(service|timer)$/.test(n));

/** A disposable root: the pinned paths below it, a source tree, a signing key, shims; the installer and the verifier re-pinned to it. */
function lab() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'topology-install-')));
  const p = (...s) => join(base, ...s);
  const L = {
    base, src: p('src/infra/rabbitmq/topology-monitor'), install: p('usr/libexec/nct'), state: p('var/lib/nct-monitor'), latchDir: p('var/lib/nct'),
    units: p('etc/systemd/system'), istate: p('var/lib/nct-install'), etc: p('etc/nct'), shim: p('shim'), ctl: p('ctl'), keys: p('keys'),
    sudoersDir: p('etc/sudoers.d'), runUnits: p('run/systemd/system'),
  };
  L.latch = join(L.latchDir, 'notification-service.containment');
  L.incident = join(L.latchDir, 'notification-service.incident');
  L.trust = join(L.etc, 'install-allowed-signers');
  L.recoveryTrust = join(L.etc, 'recovery-allowed-signers');
  L.incoming = join(L.istate, 'incoming');
  L.txn = join(L.istate, 'transaction');
  for (const d of ['usr/libexec', 'var/lib', 'etc/systemd/system', 'etc/nct', 'etc/sudoers.d', 'run/systemd/system', 'src/infra/rabbitmq/topology-monitor']) mkdirSync(p(d), { recursive: true });
  for (const d of [L.shim, L.ctl, L.keys]) mkdirSync(d);
  mkdirSync(L.istate, { mode: 0o700 }); chmodSync(L.istate, 0o700);
  mkdirSync(L.incoming, { mode: 0o700 }); chmodSync(L.incoming, 0o700);
  spawnSync('find', [base, '-type', 'd', '-not', '-path', `${L.istate}*`, '-exec', 'chmod', '755', '{}', '+']);
  chmodSync(L.keys, 0o700); chmodSync(L.ctl, 0o700);
  writeFileSync(p('etc/sudoers'), 'root ALL=(ALL:ALL) ALL\n', { mode: 0o440 });
  const uid = process.getuid(); const gid = process.getgid();
  L.user = userInfo().username;
  // crash injection: install/mv/cp/sync kill their caller at the point a test names (ctl/crash), once
  for (const [cmd, real] of [['install', '/usr/bin/install'], ['mv', '/usr/bin/mv'], ['cp', '/usr/bin/cp'], ['sync', '/usr/bin/sync']]) {
    writeFileSync(join(L.shim, cmd), ['#!/usr/bin/env bash', `c=${JSON.stringify(join(L.ctl, 'crash'))}`,
      `if [ -f "$c" ] && read -r w m when < "$c" && [ "$w" = ${cmd} ] && [[ " $* " == *"$m"* ]]; then rm -f "$c"; if [ "$when" = after ]; then ${real} "$@"; fi; kill -9 "$PPID"; exit 1; fi`,
      `exec ${real} "$@"`, ''].join('\n'), { mode: 0o755 });
  }
  // systemctl: records every call; `is-enabled` answers from ctl/enabled (default: disabled)
  writeFileSync(join(L.shim, 'systemctl'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(L.ctl, 'systemctl-calls'))}\nif [ -f ${JSON.stringify(join(L.ctl, 'systemctl-broken'))} ]; then exit 4; fi\nif [ "$1" = is-enabled ]; then if grep -qxF "$2" ${JSON.stringify(join(L.ctl, 'enabled'))} 2>/dev/null; then echo enabled; exit 0; fi; echo disabled; exit 1; fi\nexit 9\n`, { mode: 0o755 });
  // sshd -T: effective settings (ctl/sshd-extra overrides), the authorized keys file under the lab
  L.ak = p('authorized_keys');
  writeFileSync(join(L.shim, 'sshd'), `#!/usr/bin/env bash\nprintf 'pubkeyauthentication yes\\npermituserenvironment no\\nauthorizedkeysfile %s\\n' ${JSON.stringify(L.ak)}\ncat ${JSON.stringify(join(L.ctl, 'sshd-extra'))} 2>/dev/null\nexit 0\n`, { mode: 0o755 });
  // the source tree: the reviewed files (the installer and the verifier re-pinned), from which a manifest is built and signed
  for (const f of readdirSync(SRC)) cpSync(join(SRC, f), join(L.src, f));
  cpSync(join(ROOT, 'infra/rabbitmq/verify-topology.sh'), join(L.src, '..', 'verify-topology.sh'));
  const common = { INSTALL_DIR: L.install, STATE_DIR: L.state, LATCH: L.latch, INCIDENT_FILE: L.incident, UNIT_DIR: L.units, INSTALL_STATE: L.istate, INSTALL_TRUST: L.trust, TRUST_ROOT: base, RUN_AS_UID: uid, SAFE_PATH: `${L.shim}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` };
  L.installerPins = { ...common, OWNER: `${uid}:${gid}`, LOCK_WAIT: 2 };
  L.verifierPins = { ...common, TRUSTED_SIGNERS: L.recoveryTrust, OWNER_UID: uid, OWNER_GID: gid, SYSTEMCTL: join(L.shim, 'systemctl'), SSHD: join(L.shim, 'sshd'),
    SUDOERS: p('etc/sudoers'), SUDOERS_DIR: L.sudoersDir, TRIGGER_SUDOERS: join(L.sudoersDir, 'nawara-core-topology-trigger'), UNIT_SEARCH: `${L.units} ${L.runUnits}`,
    CARRIER_ETC: p('etc/nct-alert'), CARRIER_DIR: p('var/lib/nct-alert') };
  L.carrierEtc = p('etc/nct-alert'); L.carrierDir = p('var/lib/nct-alert');
  const pin = (name, pins) => { const f = join(L.src, name); writeFileSync(f, variant(readFileSync(f, 'utf8'), Object.fromEntries(Object.entries(pins).filter(([k]) => new RegExp(`^readonly ${k}=`, 'm').test(readFileSync(f, 'utf8')))))); chmodSync(f, 0o755); };
  pin('install-topology-monitor.sh', L.installerPins);
  pin('verify-topology-monitor-install.sh', L.verifierPins);
  for (const f of readdirSync(L.src)) chmodSync(join(L.src, f), /\.sh$/.test(f) ? 0o755 : 0o644);
  // the DISPOSABLE installation signing key and its trust line
  key(L, 'owner');
  trust(L, 'owner');
  return L;
}
function key(L, name) {
  const k = join(L.keys, name);
  if (!existsSync(k)) assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `test-${name}`, '-f', k], { stdio: ['ignore', 'pipe', 'pipe'] }).status, 0);
  return k;
}
function trust(L, name, ns = 'nawara-core-topology-install') {
  const pub = readFileSync(`${key(L, name)}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
  writeFileSync(L.trust, `nawara-core-owner namespaces="${ns}" ${pub}\n`, { mode: 0o644 });
  chmodSync(L.trust, 0o644);
}
const srcOf = (L, name) => (name === 'verify-topology.sh' ? join(L.src, '..', 'verify-topology.sh') : join(L.src, name));
const hashesOf = (L) => Object.fromEntries(MANIFEST_ARTIFACTS.map(([n]) => [n, sha(readFileSync(srcOf(L, n)))]));
/** Builds (or takes `text`), signs and places a manifest in the inbox; `edit` alters the text after signing. */
function approve(L, { version = 1, schema = 2, text, key: k = 'owner', ns = 'nawara-core-topology-install', edit } = {}) {
  const body = text ?? manifestText({ commit: COMMIT, version, schema, hashes: hashesOf(L) });
  const m = join(L.keys, 'manifest');
  rmSync(m, { force: true }); rmSync(`${m}.sig`, { force: true });
  writeFileSync(m, body);
  assert.equal(spawnSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key(L, k), '-n', ns, m], { stdio: ['ignore', 'pipe', 'pipe'] }).status, 0);
  writeFileSync(join(L.incoming, 'manifest'), edit ? edit(body) : body, { mode: 0o600 });
  writeFileSync(join(L.incoming, 'manifest.sig'), readFileSync(`${m}.sig`), { mode: 0o600 });
  chmodSync(join(L.incoming, 'manifest'), 0o600); chmodSync(join(L.incoming, 'manifest.sig'), 0o600);
  return body;
}
const run = (L, cmd) => spawnSync(join(L.src, 'install-topology-monitor.sh'), [cmd], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60_000 });
const verify = (L) => {
  const r = spawnSync(join(L.src, 'verify-topology-monitor-install.sh'), [], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60_000 });
  return { ...r, out: r.stdout + r.stderr };
};
const withLab = (fn) => () => { const L = lab(); try { return fn(L); } finally { rmSync(L.base, { recursive: true, force: true }); } };
const installed = (L) => existsSync(join(L.istate, 'installed', 'manifest'));
const tree = (L) => existsSync(L.install) || existsSync(L.state) || existsSync(L.latch);
const snapshot = (L) => Object.fromEntries(['state/state', 'state/recovery-consumed', 'state/incidents.jsonl', 'state/evidence.jsonl', 'latch', 'incident', 'trust', 'recoveryTrust']
  .map((k) => { const f = { latch: L.latch, incident: L.incident, trust: L.trust, recoveryTrust: L.recoveryTrust }[k] ?? join(L.state, k.split('/')[1]); return [k, existsSync(f) ? readFileSync(f, 'utf8') : null]; }));
/** A contained incident, a consumed nonce, a recovery key and evidence: the protected state no installation step may change. */
function containedState(L) {
  writeFileSync(join(L.state, 'state'), `nawara-core-topology-monitor-state v2\nservice=notification-service\ncontained=1\nincident=${'c'.repeat(32)}\nunknown_streak=0\nlast_result=FAIL\nlast_run=1792800000\n`, { mode: 0o600 });
  writeFileSync(join(L.state, 'recovery-consumed'), `v1 nonce=${'d'.repeat(32)} incident=${'e'.repeat(32)} at=1792700000\n`, { mode: 0o600 });
  writeFileSync(join(L.state, 'incidents.jsonl'), `{"incident":"${'c'.repeat(32)}"}\n`, { mode: 0o600 });
  writeFileSync(join(L.state, 'evidence.jsonl'), '{"v":1,"kind":"contained"}\n', { mode: 0o600 });
  writeFileSync(L.latch, LATCH_CONTAINED, { mode: 0o644 });
  writeFileSync(L.incident, `nawara-core-topology-incident v1\nservice=notification-service\nincident=${'c'.repeat(32)}`, { mode: 0o644 });
  trust(L, 'owner');
  writeFileSync(L.recoveryTrust, `nawara-core-owner namespaces="nawara-core-topology-recovery" ${readFileSync(`${key(L, 'recovery')}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ')}\n`, { mode: 0o644 });
  chmodSync(L.recoveryTrust, 0o644);
}

// ------------------------------------------------------------------------------------------------ the manifest and its authority

test('the generator hashes the artifacts of a COMMIT (its Git objects, never the working tree), canonically; a non-commit or bad version is refused', () => {
  // a disposable repository holding exactly the reviewed artifacts (the project's own repository is never written)
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'topology-manifest-')));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    git('init', '-q');
    for (const [, path] of MANIFEST_ARTIFACTS) { mkdirSync(join(repo, path, '..'), { recursive: true }); cpSync(join(ROOT, path), join(repo, path)); }
    git('add', '-A'); git('commit', '-q', '-m', 'artifacts');
    const head = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, MANIFEST_ARTIFACTS[0][1]), 'changed after the commit\n'); // the working tree differs from the commit
    const m = manifestOfCommit({ commit: head, version: 7, cwd: repo });
    const lines = m.split('\n');
    assert.deepEqual(lines.slice(0, 4), ['nawara-core-topology-monitor-manifest v2', `core_commit=${head}`, 'version=7', 'state_schema=2']);
    assert.equal(lines.length, 4 + MANIFEST_ARTIFACTS.length + 1);
    for (const [i, [name, path]] of MANIFEST_ARTIFACTS.entries()) assert.equal(lines[4 + i], `file=${sha(readFileSync(join(ROOT, path)))} ${name}`);
    assert.ok(m.endsWith('\n') && !m.endsWith('\n\n'));
    assert.throws(() => manifestOfCommit({ commit: 'HEAD', version: 1, cwd: repo }), /full commit id/);
    assert.throws(() => manifestText({ commit: head, version: 0, hashes: {} }), /version/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('1, 11, 14, 34: a valid Owner-signed manifest installs; the verification PASSES; no unit is enabled, started or reloaded', withLab((L) => {
  approve(L);
  const r = run(L, 'install');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NOT enabled, NOT started/);
  assert.ok(installed(L));
  assert.ok(!existsSync(L.txn), 'no open transaction');
  for (const [name] of MANIFEST_ARTIFACTS) {
    const dest = UNITS.includes(name) ? join(L.units, name) : join(L.install, name);
    assert.equal(sha(readFileSync(dest)), sha(readFileSync(srcOf(L, name))), name);
  }
  assert.match(readFileSync(join(L.state, 'state'), 'utf8'), /^nawara-core-topology-monitor-state v2\n.*\ncontained=0\nincident=none\n/s);
  assert.equal(existsSync(join(L.ctl, 'systemctl-calls')), false, 'the installer never ran systemctl');
  const v = verify(L);
  assert.equal(v.status, 0, v.out);
  assert.match(v.out, /RESULT: PASS/);
  assert.match(v.out, /info +trigger: not configured/);
  assert.match(v.out, /info +recovery key: not installed/);
  assert.match(v.out, /ok +enablement: no timer is enabled/);
  assert.ok(!readFileSync(join(L.ctl, 'systemctl-calls'), 'utf8').split('\n').some((c) => /^(enable|start|daemon-reload|restart)/.test(c)), 'the verifier only reads');
}));

for (const [n, what, prepare, code, reason] of [
  ['2', 'a tampered artifact (changed after the manifest was signed)', (L) => { approve(L); writeFileSync(join(L.src, 'topology-watchdog.sh'), `${readFileSync(join(L.src, 'topology-watchdog.sh'), 'utf8')}# x\n`); }, 1, 'source_hash'],
  ['3', 'a tampered manifest (edited after signing)', (L) => approve(L, { edit: (t) => t.replace('version=1', 'version=2') }), 1, 'manifest_signature'],
  ['3', 'a manifest signed by another key', (L) => approve(L, { key: 'intruder' }), 1, 'manifest_signature'],
  ['3', 'a manifest signed in another namespace (a recovery signature)', (L) => approve(L, { ns: 'nawara-core-topology-recovery' }), 1, 'manifest_signature'],
  ['4', 'another state schema', (L) => approve(L, { schema: 3 }), 1, 'schema'],
  ['4', 'a commit that is not a full id', (L) => approve(L, { text: manifestText({ commit: COMMIT, version: 1, hashes: hashesOf(L) }).replace(`core_commit=${COMMIT}`, 'core_commit=main') }), 1, 'manifest_format'],
  ['5', 'a manifest missing an artifact', (L) => approve(L, { text: manifestText({ commit: COMMIT, version: 1, hashes: hashesOf(L) }).replace(/^file=\S+ topology-trigger\.sh\n/m, '') }), 1, 'manifest_format'],
  ['5', 'a missing source artifact', (L) => { approve(L); rmSync(join(L.src, 'topology-trigger.sh')); }, 1, 'source_file'],
  ['6', 'an extra artifact', (L) => approve(L, { text: `${manifestText({ commit: COMMIT, version: 1, hashes: hashesOf(L) })}file=${'0'.repeat(64)} rogue.sh\n` }), 1, 'manifest_format'],
  ['7', 'a symbolic-link source', (L) => { approve(L); const f = join(L.src, 'topology-trigger.sh'); cpSync(f, `${f}.real`); rmSync(f); symlinkSync(`${f}.real`, f); }, 1, 'source_file'],
  ['8', 'a hard-linked source', (L) => { approve(L); linkSync(join(L.src, 'topology-trigger.sh'), join(L.base, 'second-link')); }, 1, 'source_file'],
  ['9', 'a group-writable parent of the install directory', (L) => { approve(L); chmodSync(join(L.base, 'usr/libexec'), 0o775); }, 65, 'unsafe'],
  ['9', 'a parent that is a symbolic link', (L) => { approve(L); spawnSync('mv', [join(L.base, 'var/lib'), join(L.base, 'var/lib-real')]); symlinkSync(join(L.base, 'var/lib-real'), join(L.base, 'var/lib')); }, 65, 'unsafe'],
  ['10', 'a garbage signature', (L) => { approve(L); writeFileSync(join(L.incoming, 'manifest.sig'), 'not a signature\n'); }, 1, 'manifest_signature'],
  ['10', 'a wildcard principal in the installation trust key', (L) => { approve(L); writeFileSync(L.trust, readFileSync(L.trust, 'utf8').replace('nawara-core-owner ', 'nawara-core-* ')); }, 65, 'unsafe'],
  ['10', 'no installation trust key', (L) => { approve(L); rmSync(L.trust); }, 65, 'unsafe'],
  ['10', 'a weakly permissioned manifest in the inbox', (L) => { approve(L); chmodSync(join(L.incoming, 'manifest'), 0o666); }, 1, 'manifest_file'],
]) {
  test(`${n}: ${what} is refused; nothing is installed and no transaction is left`, withLab((L) => {
    prepare(L);
    const r = run(L, 'install');
    assert.equal(r.status, code, r.stderr);
    assert.match(r.stderr, new RegExp(`REFUSED \\(${reason}`));
    assert.ok(!installed(L) && !tree(L) && !existsSync(L.txn), 'nothing changed');
  }));
}

// ------------------------------------------------------------------------------------------------ fresh installation

test('12, 13: an existing installation or an existing (contained) latch or state is never overwritten', withLab((L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  approve(L);
  assert.match(run(L, 'install').stderr, /REFUSED \(already_installed\)/);
  const L2 = lab();
  try {
    mkdirSync(L2.latchDir, { mode: 0o755 }); chmodSync(L2.latchDir, 0o755);
    writeFileSync(L2.latch, LATCH_CONTAINED, { mode: 0o644 });
    approve(L2);
    assert.match(run(L2, 'install').stderr, /REFUSED \(target_exists\)/);
    assert.equal(readFileSync(L2.latch, 'utf8'), LATCH_CONTAINED);
    assert.ok(!existsSync(L2.install) && !existsSync(L2.txn));
  } finally {
    rmSync(L2.base, { recursive: true, force: true });
  }
}));

test('15, 20, 21: a crash at every installation checkpoint leaves a VISIBLY incomplete transaction that only an explicit repair completes', () => {
  for (const [cmd, match, when] of [
    ['install', 'verify-and-contain.sh', 'before'], // before the first artifact
    ['mv', 'topology-trigger.sh.txn-new', 'after'], // after some artifacts
    ['install', 'nawara-core-topology-watchdog.timer', 'after'], // after the last artifact's ownership and mode, before its rename
    ['mv', 'notification-service.containment', 'before'], // while the protected state is initialized
    ['cp', 'installed/manifest.sig', 'before'], // after the final verification, before the record
  ]) {
    const L = lab();
    try {
      approve(L);
      writeFileSync(join(L.ctl, 'crash'), `${cmd} ${match} ${when}\n`);
      assert.notEqual(run(L, 'install').status, 0, `${cmd} ${match} ${when}`);
      assert.ok(existsSync(join(L.txn, 'transaction')), `${match}: the transaction marker remains`);
      assert.match(run(L, 'status').stdout, /transaction: OPEN/);
      const v = verify(L);
      assert.notEqual(v.status, 0, `${match}: never healthy`);
      assert.match(v.out, /FAIL +transaction \(incomplete_transaction\)/);
      approve(L);
      const again = run(L, 'install');
      assert.equal(again.status, 70, `${match}: an ordinary install refuses`);
      const r = run(L, 'repair');
      assert.equal(r.status, 0, `${match}: ${r.stderr}`);
      assert.ok(installed(L) && !existsSync(L.txn));
      const ok = verify(L);
      assert.equal(ok.status, 0, `${match}: ${ok.out}`);
    } finally {
      rmSync(L.base, { recursive: true, force: true });
    }
  }
});

// ------------------------------------------------------------------------------------------------ upgrades, rollback, repair

test('16-19, 22: an approved upgrade and a signed rollback replace ONLY the immutable artifacts; containment, incident, nonces and keys survive', withLab((L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  containedState(L);
  const before = snapshot(L);
  const original = readFileSync(join(L.src, 'nawara-core-topology-watchdog.timer'), 'utf8');
  writeFileSync(join(L.src, 'nawara-core-topology-watchdog.timer'), `${original}# upgraded\n`);
  approve(L, { version: 2 });
  let r = run(L, 'upgrade');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(L.units, 'nawara-core-topology-watchdog.timer'), 'utf8'), /# upgraded/);
  assert.deepEqual(snapshot(L), before, 'the protected state is byte-identical after the upgrade');
  // rollback = a NEWLY signed, higher version naming the older artifact
  writeFileSync(join(L.src, 'nawara-core-topology-watchdog.timer'), original);
  approve(L, { version: 3 });
  r = run(L, 'upgrade');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(L.units, 'nawara-core-topology-watchdog.timer'), 'utf8'), original);
  assert.deepEqual(snapshot(L), before, 'and after the rollback');
  assert.match(verify(L).out, /RESULT: PASS/);
  const history = readFileSync(join(L.istate, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(history.map((h) => [h.kind, h.from_version, h.to_version]), [['install', 0, 1], ['upgrade', 1, 2], ['upgrade', 2, 3]]);
}));

test('23: an unauthorized downgrade (a version not higher than the installed one) is refused', withLab((L) => {
  approve(L, { version: 5 });
  assert.equal(run(L, 'install').status, 0);
  for (const v of [5, 4, 1]) {
    approve(L, { version: v });
    assert.match(run(L, 'upgrade').stderr, /REFUSED \(downgrade\)/, `version ${v}`);
  }
}));

test('an upgrade over a TAMPERED installation is refused (it must first match its signed record)', withLab((L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  const f = join(L.install, 'topology-watchdog.sh');
  chmodSync(f, 0o755); writeFileSync(f, `${readFileSync(f, 'utf8')}# tampered\n`); chmodSync(f, 0o555);
  approve(L, { version: 2 });
  assert.match(run(L, 'upgrade').stderr, /REFUSED \(installation_not_intact\)/);
}));

test('20, 21: a crash during an upgrade fails closed and is repaired explicitly; the contained state is untouched throughout', withLab((L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  containedState(L);
  const before = snapshot(L);
  writeFileSync(join(L.src, 'topology-watchdog.sh'), `${readFileSync(join(L.src, 'topology-watchdog.sh'), 'utf8')}# v2\n`);
  approve(L, { version: 2 });
  writeFileSync(join(L.ctl, 'crash'), 'mv topology-watchdog.sh.txn-new after\n');
  assert.notEqual(run(L, 'upgrade').status, 0);
  assert.deepEqual(snapshot(L), before);
  assert.match(verify(L).out, /incomplete_transaction/);
  assert.equal(run(L, 'upgrade').status, 70);
  const r = run(L, 'repair');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(L), before);
  assert.match(verify(L).out, /RESULT: PASS/);
}));

test('24: an upgrade while a monitor or recovery run holds its lock is refused (75) and changes nothing; locks never invert', withLab(async (L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  writeFileSync(join(L.src, 'topology-watchdog.sh'), `${readFileSync(join(L.src, 'topology-watchdog.sh'), 'utf8')}# v2\n`);
  approve(L, { version: 2 });
  const holder = spawn('flock', [join(L.state, 'lock'), 'sleep', '30'], { detached: true, stdio: 'ignore' });
  try {
    spawnSync('sleep', ['0.3']);
    const r = run(L, 'upgrade');
    assert.equal(r.status, 75, r.stderr);
    assert.ok(!existsSync(L.txn), 'no transaction was opened');
    assert.doesNotMatch(readFileSync(join(L.install, 'topology-watchdog.sh'), 'utf8'), /# v2/);
  } finally {
    try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}));

// ------------------------------------------------------------------------------------------------ the read-only verification

const DAMAGE = [
  ['an altered executable', (L) => { const f = join(L.install, 'verify-and-contain.sh'); chmodSync(f, 0o755); writeFileSync(f, `${readFileSync(f, 'utf8')}#\n`); chmodSync(f, 0o555); }, /hash_mismatch/],
  ['an altered unit', (L) => { const f = join(L.units, 'nawara-core-topology-monitor.timer'); writeFileSync(f, `${readFileSync(f, 'utf8')}#\n`); }, /hash_mismatch/],
  ['a weak mode', (L) => chmodSync(join(L.install, 'topology-trigger.sh'), 0o775), /mode_or_owner/],
  ['a symbolic link', (L) => { const f = join(L.install, 'topology-trigger.sh'); cpSync(f, join(L.base, 'copy')); rmSync(f); symlinkSync(join(L.base, 'copy'), f); }, /mode_or_owner/],
  ['a hard link', (L) => linkSync(join(L.install, 'topology-watchdog.sh'), join(L.base, 'second')), /mode_or_owner/],
  ['an extra executable', (L) => writeFileSync(join(L.install, 'rogue.sh'), '#!/bin/sh\n', { mode: 0o555 }), /unexpected_file/],
  ['a missing state', (L) => rmSync(join(L.state, 'state')), /state_invalid/],
  ['a corrupt state', (L) => writeFileSync(join(L.state, 'state'), 'contained=0\n'), /state_invalid/],
  ['an altered installed record', (L) => { const f = join(L.istate, 'installed', 'manifest'); writeFileSync(f, readFileSync(f, 'utf8').replace('version=1', 'version=9')); }, /manifest_signature/],
];
for (const [what, damage, reason] of DAMAGE) {
  test(`25-28, 33: ${what} is detected: FAIL, never PASS`, withLab((L) => {
    approve(L);
    assert.equal(run(L, 'install').status, 0);
    assert.equal(verify(L).status, 0);
    damage(L);
    const v = verify(L);
    assert.equal(v.status, 1, v.out);
    assert.match(v.out, reason);
    assert.doesNotMatch(v.out, /RESULT: PASS/);
  }));
}

test('29: a drop-in or a same-named unit in another systemd directory is detected', withLab((L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  mkdirSync(join(L.units, 'nawara-core-topology-monitor.service.d'));
  writeFileSync(join(L.units, 'nawara-core-topology-monitor.service.d', 'override.conf'), '[Service]\nExecStart=\nExecStart=/bin/true\n');
  let v = verify(L);
  assert.equal(v.status, 1);
  assert.match(v.out, /unit_override/);
  rmSync(join(L.units, 'nawara-core-topology-monitor.service.d'), { recursive: true });
  writeFileSync(join(L.runUnits, 'nawara-core-topology-watchdog.timer'), '[Timer]\n');
  v = verify(L);
  assert.match(v.out, /unit_override/);
}));

test('enablement: a timer enabled without a signed activation authorization FAILS; with one for the installed version it passes; unreadable is UNKNOWN', withLab((L) => {
  const manifest = approve(L);
  assert.equal(run(L, 'install').status, 0);
  writeFileSync(join(L.ctl, 'enabled'), 'nawara-core-topology-monitor.timer\n');
  let v = verify(L);
  assert.equal(v.status, 1);
  assert.match(v.out, /unauthorized_activation/);
  const a = join(L.istate, 'activation');
  writeFileSync(a, `nawara-core-topology-monitor-activation v1\ncore_commit=${COMMIT}\nversion=1\ntimers=nawara-core-topology-monitor.timer,nawara-core-topology-watchdog.timer\n`, { mode: 0o600 });
  assert.equal(spawnSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key(L, 'owner'), '-n', 'nawara-core-topology-install', a], { stdio: ['ignore', 'pipe', 'pipe'] }).status, 0);
  chmodSync(`${a}.sig`, 0o600);
  v = verify(L);
  assert.equal(v.status, 0, v.out);
  assert.match(v.out, /enabled under a signed activation authorization for version 1/);
  void manifest;
  writeFileSync(join(L.ctl, 'systemctl-broken'), '');
  v = verify(L);
  assert.equal(v.status, 3, v.out);
  assert.match(v.out, /RESULT: UNKNOWN/);
  assert.match(v.out, /systemctl_unavailable/);
}));

// ------------------------------------------------------------------------------------------------ OD-BRK-2b-A: the external alert carrier

const activation = (L, timers) => {
  const a = join(L.istate, 'activation');
  rmSync(a, { force: true }); rmSync(`${a}.sig`, { force: true });
  writeFileSync(a, `nawara-core-topology-monitor-activation v1\ncore_commit=${COMMIT}\nversion=1\ntimers=${timers}\n`, { mode: 0o600 });
  assert.equal(spawnSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key(L, 'owner'), '-n', 'nawara-core-topology-install', a], { stdio: ['ignore', 'pipe', 'pipe'] }).status, 0);
  chmodSync(`${a}.sig`, 0o600);
};
test('A25, A27, A29, A32: the carrier and its units are signed artifacts, installed DISABLED; no credential is an artifact or installed', withLab((L) => {
  assert.deepEqual(MANIFEST_ARTIFACTS.map(([n]) => n).filter((n) => /alert/.test(n)), ['topology-alert-carrier.sh', 'nawara-core-topology-alert.service', 'nawara-core-topology-alert.timer']);
  assert.ok(!MANIFEST_ARTIFACTS.some(([n]) => /pushover|healthchecks|token|credential/i.test(n)));
  const body = approve(L);
  assert.match(body, /^nawara-core-topology-monitor-manifest v2\n/);
  assert.match(body, /^file=[0-9a-f]{64} topology-alert-carrier\.sh$/m);
  const r = run(L, 'install');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(L.install, 'topology-alert-carrier.sh'), 'utf8'), readFileSync(join(SRC, 'topology-alert-carrier.sh'), 'utf8'));
  for (const u of ['nawara-core-topology-alert.service', 'nawara-core-topology-alert.timer']) assert.ok(existsSync(join(L.units, u)), u);
  assert.ok(!existsSync(L.carrierEtc) && !existsSync(L.carrierDir), 'no credential directory and no carrier state are created by the installer');
  assert.equal(existsSync(join(L.ctl, 'systemctl-calls')), false, 'nothing enabled or started');
  const v = verify(L);
  assert.equal(v.status, 0, v.out);
  assert.match(v.out, /ok +artifact topology-alert-carrier\.sh: sha256 equals the signed manifest/);
  assert.match(v.out, /ok +artifact nawara-core-topology-alert\.timer: sha256 equals the signed manifest/);
  assert.match(v.out, /ok +hardening: nawara-core-topology-alert\.service is isolated from the broker and the Auth carrier/);
  assert.match(v.out, /info +carrier: not configured/);
}));

test('A26: a tampered carrier source is refused; a carrier unit weakened in a SIGNED manifest still FAILS its hardening check', withLab((L) => {
  approve(L);
  writeFileSync(join(L.src, 'topology-alert-carrier.sh'), `${readFileSync(join(L.src, 'topology-alert-carrier.sh'), 'utf8')}curl https://elsewhere.invalid\n`);
  const r = run(L, 'install');
  assert.equal(r.status, 1); assert.match(r.stderr, /REFUSED \(source_hash\): the source topology-alert-carrier\.sh/);
  writeFileSync(join(L.src, 'topology-alert-carrier.sh'), readFileSync(join(SRC, 'topology-alert-carrier.sh')));
  const unit = join(L.src, 'nawara-core-topology-alert.service');
  writeFileSync(unit, readFileSync(unit, 'utf8').replace(/^InaccessiblePaths=-\/run\/docker\.sock.*\n/m, '').replace('UMask=0077', 'UMask=0077\nReadWritePaths=/var/lib/nawara-core-topology-monitor'));
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  const v = verify(L);
  assert.equal(v.status, 1, v.out);
  assert.match(v.out, /FAIL +hardening \(unit_hardening\): nawara-core-topology-alert\.service lacks: InaccessiblePaths=-\/run\/docker\.sock.* \(an identity, a writable path/);
}));

test('A29: the carrier timer is enabled only under a signed activation that LISTS it', withLab((L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  writeFileSync(join(L.ctl, 'enabled'), 'nawara-core-topology-monitor.timer\nnawara-core-topology-alert.timer\n');
  activation(L, 'nawara-core-topology-monitor.timer,nawara-core-topology-watchdog.timer');
  let v = verify(L);
  assert.equal(v.status, 1, v.out);
  assert.match(v.out, /unauthorized_activation\): nawara-core-topology-monitor\.timer nawara-core-topology-alert\.timer enabled without a signed activation authorization for the installed version that lists it/);
  activation(L, 'nawara-core-topology-monitor.timer,nawara-core-topology-watchdog.timer,nawara-core-topology-alert.timer');
  v = verify(L);
  assert.equal(v.status, 0, v.out);
  activation(L, 'nawara-core-topology-alert.timer');
  assert.equal(verify(L).status, 1, 'never a list that is not the canonical one');
}));

test('A27, A31, A33: the carrier credentials, when configured: root-only files, the providers\' form, two distinct checks; never printed', withLab((L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  mkdirSync(L.carrierEtc, { mode: 0o700 }); chmodSync(L.carrierEtc, 0o700);
  mkdirSync(L.carrierDir, { mode: 0o700 }); chmodSync(L.carrierDir, 0o700);
  const secret = { token: 'TestTokenOnly00000000000000001', user: 'TestUserOnly000000000000000001', m: 'https://hc-ping.com/11111111-1111-4111-8111-111111111111', w: 'https://hc-ping.com/22222222-2222-4222-8222-222222222222' };
  const write = (vals, mode = 0o400) => {
    for (const [f, v] of [['pushover.token', vals.token], ['pushover.user', vals.user], ['healthchecks-monitor.url', vals.m], ['healthchecks-watchdog.url', vals.w]]) {
      rmSync(join(L.carrierEtc, f), { force: true }); writeFileSync(join(L.carrierEtc, f), `${v}\n`, { mode }); chmodSync(join(L.carrierEtc, f), mode);
    }
  };
  write(secret);
  let v = verify(L);
  assert.equal(v.status, 0, v.out);
  assert.match(v.out, /ok +carrier heartbeats: two different Healthchecks\.io checks/);
  for (const s of Object.values(secret)) assert.ok(!v.out.includes(s), 'a credential value is never printed');
  write(secret, 0o644);
  v = verify(L); assert.equal(v.status, 1); assert.match(v.out, /credential_unsafe/);
  write({ ...secret, w: secret.m });
  v = verify(L); assert.equal(v.status, 1); assert.match(v.out, /shared_check/);
  write({ ...secret, m: 'https://hc-ping.example.invalid/11111111-1111-4111-8111-111111111111' });
  v = verify(L); assert.equal(v.status, 1); assert.match(v.out, /credential_format/);
  write(secret); rmSync(join(L.carrierEtc, 'pushover.user')); symlinkSync(join(L.carrierEtc, 'pushover.token'), join(L.carrierEtc, 'pushover.user'));
  v = verify(L); assert.equal(v.status, 1); assert.match(v.out, /credential_unsafe/);
  for (const s of Object.values(secret)) assert.ok(!v.out.includes(s));
  // nothing in the reviewed artifacts is a real endpoint or secret: only the fixed provider hosts and placeholders
  for (const [n, path] of MANIFEST_ARTIFACTS) {
    const t = readFileSync(join(ROOT, path), 'utf8');
    assert.doesNotMatch(t, /hc-ping\.com\/[0-9a-f]{8}-|hc-ping\.com\/[A-Za-z0-9_-]{22}\//, `${n}: no real check URL`);
    assert.doesNotMatch(t, /(token|user)=[A-Za-z0-9]{30}\b/, `${n}: no Pushover credential`);
  }
}));

test('A30: an installation recorded under the OD-BRK-2b-I v1 contract is refused by upgrade (installed_contract), changing nothing', withLab((L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  containedState(L);
  const f = join(L.istate, 'installed', 'manifest');
  writeFileSync(f, readFileSync(f, 'utf8').replace('manifest v2', 'manifest v1'));
  const before = snapshot(L);
  approve(L, { version: 2 });
  const r = run(L, 'upgrade');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /REFUSED \(installed_contract\)/);
  assert.deepEqual(snapshot(L), before);
  assert.ok(!existsSync(L.txn));
}));

/** Replaces a file (removed first, as a mode 0440 file cannot be rewritten) with `text` and `mode`. */
const put = (f, text, mode) => { rmSync(f, { force: true }); writeFileSync(f, text, { mode }); chmodSync(f, mode); };
test('30-32: the optional trigger: absent is "not configured"; a wrong forced command, a reused backup key or a broad sudoers rule FAILS', withLab((L) => {
  approve(L);
  assert.equal(run(L, 'install').status, 0);
  assert.match(verify(L).out, /info +trigger: not configured/);
  const rule = join(L.sudoersDir, 'nawara-core-topology-trigger');
  put(rule, `Defaults!/usr/bin/systemctl env_reset\n${L.user} ALL=(root) NOPASSWD: /usr/bin/systemctl start nawara-core-topology-monitor.service\n`, 0o440);
  const pub = readFileSync(`${key(L, 'trigger')}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
  const good = `restrict,command="/usr/local/libexec/nawara-core-topology/topology-trigger.sh" ${pub} nawara-core-topology-trigger\n`;
  writeFileSync(L.ak, good);
  let v = verify(L);
  assert.equal(v.status, 0, v.out);
  assert.match(v.out, /ok +trigger key: exactly the restricted forced-command line/);
  writeFileSync(L.ak, good.replace('restrict,command=', 'command='));
  assert.match(verify(L).out, /forced_command/, 'without restrict (shell, forwarding, agent, PTY possible)');
  writeFileSync(L.ak, `${good}restrict,command="/usr/local/libexec/nawara-core-backup/scheduled-backup.sh" ${pub} nawara-core-scheduled-backup\n`);
  assert.match(verify(L).out, /key_reuse/);
  writeFileSync(L.ak, good);
  put(join(L.sudoersDir, 'other'), `${L.user} ALL=(ALL) NOPASSWD: ALL\n`, 0o440);
  assert.match(verify(L).out, /broad_sudo/);
  rmSync(join(L.sudoersDir, 'other'));
  put(rule, `Defaults!/usr/bin/systemctl env_reset\n${L.user} ALL=(root) NOPASSWD: /usr/bin/systemctl *\n`, 0o440);
  assert.match(verify(L).out, /sudoers_rule/);
  put(rule, `Defaults!/usr/bin/systemctl env_reset\n${L.user} ALL=(root) NOPASSWD: /usr/bin/systemctl start nawara-core-topology-monitor.service\n`, 0o440);
  writeFileSync(join(L.ctl, 'sshd-extra'), 'forcecommand /bin/bash\n');
  assert.match(verify(L).out, /sshd_settings/);
}));

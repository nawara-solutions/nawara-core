// Core V2 M2 T6: the network probe's two scripts, exactly as .github/workflows/core-network-probe.yml carries them and run as GitHub runs a
// `run:` step (bash --noprofile --norc -eo pipefail), with SYNTHETIC values only. The validation refuses every destination outside the
// tailnet range 100.64.0.0/10, every malformed port and fingerprint, before anything is contacted. The probe runs inside a throwaway,
// unprivileged network namespace (unshare --user --net) where a synthetic tailnet-range address sits on the loopback interface and an
// unprivileged sshd offers synthetic host keys: a matching ECDSA key passes, a different key, a missing ECDSA key and a closed port fail,
// sshd records that nobody attempted to authenticate, and no output line ever contains the address, the port or a fingerprint. Nothing
// leaves the namespace; no production address, credential, key or service is used. The probe cases are skipped where an unprivileged
// network namespace or sshd is unavailable (some CI runners restrict user namespaces); the validation cases always run.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { PROBE_ENV, PROBE_JOB, PROBE_WORKFLOW } from '../lib/checks.mjs';

const SSHD = '/usr/sbin/sshd';
const HOST = '100.100.100.100';
const PORT = '2222';
const OTHER_PORT = '2223';
const doc = parse(readFileSync(new URL(`../../.github/workflows/${PROBE_WORKFLOW}`, import.meta.url), 'utf8'));
const steps = doc.jobs[PROBE_JOB].steps;
const VALIDATE = steps.find((s) => s.name === 'Validate the probe configuration');
const PROBE = steps.find((s) => s.name === 'Probe the SSH port and host key (no authentication)');

let T; let skip = '';
const keys = {};
const keygen = (name, type) => {
  const r = spawnSync('ssh-keygen', ['-q', '-t', type, '-N', '', '-C', `synthetic-${name}`, '-f', join(T, name)]);
  assert.equal(r.status, 0, String(r.stderr));
  const fp = spawnSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', join(T, `${name}.pub`)], { encoding: 'utf8' }).stdout.split(' ')[1];
  return { path: join(T, name), fp };
};

/** Runs a workflow step's script as GitHub does, with exactly these environment values. */
function runStep(step, env, wrapper) {
  const script = join(T, `step-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(script, step.run);
  const base = { PATH: process.env.PATH, HOME: T, LANG: 'C.UTF-8' };
  const r = wrapper
    ? spawnSync('unshare', ['--user', '--map-current-user', '--net', '--keep-caps', 'bash', '--noprofile', '--norc', '-c', wrapper(script)], { env: { ...base, ...env }, encoding: 'utf8', timeout: 60000 })
    : spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { env: { ...base, ...env }, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Inside the namespace: the synthetic tailnet address on lo, an optional sshd offering `hostKeys`, then the probe script. */
const inNamespace = (name, hostKeys) => (script) => {
  const conf = join(T, `${name}.conf`);
  const log = join(T, `${name}.log`);
  writeFileSync(log, '');
  if (hostKeys) {
    writeFileSync(conf, [`Port ${PORT}`, `ListenAddress ${HOST}`, ...hostKeys.map((k) => `HostKey ${k.path}`), `PidFile ${join(T, `${name}.pid`)}`,
      'UsePAM no', 'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'LogLevel VERBOSE', ''].join('\n'));
  }
  return [
    `ip addr add ${HOST}/32 dev lo && ip link set lo up || exit 97`,
    hostKeys ? `${SSHD} -D -E '${log}' -f '${conf}' & pid=$!` : 'pid=',
    hostKeys ? `for i in $(seq 200); do (exec 3<>/dev/tcp/${HOST}/${PORT}) 2>/dev/null && break; sleep 0.05; done` : 'true',
    `bash --noprofile --norc -eo pipefail '${script}'; rc=$?`,
    '[ -z "$pid" ] || { kill "$pid"; wait "$pid" 2>/dev/null; }',
    'exit $rc',
  ].join('\n');
};
const logOf = (name) => readFileSync(join(T, `${name}.log`), 'utf8');

/** No output line may name the address, the port or a fingerprint (GitHub's masking is a second layer, not the first). */
function assertSilent(out, ...secrets) {
  for (const s of secrets) assert.ok(!out.includes(s), `the output must not contain a configured value: ${out}`);
  for (const line of out.trim().split('\n')) assert.match(line, /^(PASS |::error::FAIL )/, `only PASS/FAIL lines are printed: ${line}`);
}

before(() => {
  T = mkdtempSync(join(tmpdir(), 't6-network-probe-'));
  keys.ecdsa = keygen('ecdsa', 'ecdsa');
  keys.other = keygen('other-ecdsa', 'ecdsa');
  keys.ed25519 = keygen('ed25519', 'ed25519');
  if (!existsSync(SSHD)) skip = 'no sshd';
  else if (spawnSync('unshare', ['--user', '--map-current-user', '--net', '--keep-caps', 'ip', 'link', 'set', 'lo', 'up']).status !== 0) {
    skip = 'unprivileged network namespaces are unavailable here';
  }
});
after(() => { if (T) rmSync(T, { recursive: true, force: true }); });

test('T6: both script steps read exactly the probe env and nothing else', () => {
  assert.deepEqual(VALIDATE.env, PROBE_ENV);
  assert.deepEqual(PROBE.env, PROBE_ENV);
});

test('T6: the validation passes a tailnet IPv4 address, a TCP port and a SHA256 fingerprint, and prints none of them', () => {
  for (const host of ['100.64.0.1', HOST, '100.127.255.254']) {
    const r = runStep(VALIDATE, { TS_PROBE_HOST: host, DEPLOY_SSH_PORT: PORT, DEPLOY_SSH_FINGERPRINT: keys.ecdsa.fp });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PASS destination[\s\S]*PASS port[\s\S]*PASS fingerprint/);
    assertSilent(r.out, host, PORT, keys.ecdsa.fp);
  }
});

test('T6: the validation refuses every destination outside 100.64.0.0/10, a bad port or fingerprint, before contacting anything', () => {
  const ok = { TS_PROBE_HOST: HOST, DEPLOY_SSH_PORT: PORT, DEPLOY_SSH_FINGERPRINT: keys.ecdsa.fp };
  const cases = [
    ...['', '192.168.1.20', '10.0.0.5', '172.16.0.1', '203.0.113.7', '100.63.255.255', '100.128.0.1', '127.0.0.1', '0.0.0.0', '100.064.0.1',
      ' 100.64.0.1', '100.64.0.1\n', '100.64.0.1/32', 'fd7a:115c:a1e0::1', '::ffff:100.64.0.1', 'server1.example', 'server1.tailnet.ts.net']
      .map((v) => [{ TS_PROBE_HOST: v }, /FAIL destination/]),
    ...['', '0', '022', '65536', '99999', '22a', '-1', ' 22', '2222\n'].map((v) => [{ DEPLOY_SSH_PORT: v }, /FAIL port/]),
    ...['', 'SHA256:short', `MD5:${'a'.repeat(43)}`, `${keys.ecdsa.fp} `, `${keys.ecdsa.fp}x`].map((v) => [{ DEPLOY_SSH_FINGERPRINT: v }, /FAIL fingerprint/]),
  ];
  for (const [env, re] of cases) {
    const values = { ...ok, ...env };
    const r = runStep(VALIDATE, values);
    assert.equal(r.status, 1, `${JSON.stringify(env)}: ${r.out}`);
    assert.match(r.out, re, JSON.stringify(env));
    assertSilent(r.out, ...Object.values(env).filter((v) => v.trim().length > 3));
  }
  const unset = runStep(VALIDATE, { DEPLOY_SSH_PORT: PORT, DEPLOY_SSH_FINGERPRINT: keys.ecdsa.fp });
  assert.equal(unset.status, 1, 'an unset TS_PROBE_HOST is refused');
});

test('T6: the probe passes on the pinned ECDSA host key, with no authentication attempt and no value printed', { skip: skip || false }, (t) => {
  if (skip) return t.skip(skip);
  const r = runStep(PROBE, { TS_PROBE_HOST: HOST, DEPLOY_SSH_PORT: PORT, DEPLOY_SSH_FINGERPRINT: keys.ecdsa.fp }, inNamespace('match', [keys.ecdsa, keys.ed25519]));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS tcp[\s\S]*PASS host key: matches[\s\S]*PASS T6 network probe/);
  assertSilent(r.out, HOST, PORT, keys.ecdsa.fp, keys.ed25519.fp);
  const log = logOf('match');
  assert.match(log, /\[preauth\]|without attempting authentication/, log);
  assert.doesNotMatch(log, /Accepted|Failed (password|publickey|none)|Invalid user|userauth_request|Postponed/i, log);
});

test('T6: the probe fails on another ECDSA host key, on a server without one, and on a closed port', { skip: skip || false }, (t) => {
  if (skip) return t.skip(skip);
  const wrong = runStep(PROBE, { TS_PROBE_HOST: HOST, DEPLOY_SSH_PORT: PORT, DEPLOY_SSH_FINGERPRINT: keys.ecdsa.fp }, inNamespace('wrong', [keys.other]));
  assert.equal(wrong.status, 1, wrong.out);
  assert.match(wrong.out, /PASS tcp[\s\S]*FAIL host key: does NOT match/);
  assertSilent(wrong.out, HOST, PORT, keys.ecdsa.fp, keys.other.fp);
  assert.doesNotMatch(logOf('wrong'), /Accepted|Failed (password|publickey|none)|Invalid user|userauth_request/i);

  const noEcdsa = runStep(PROBE, { TS_PROBE_HOST: HOST, DEPLOY_SSH_PORT: PORT, DEPLOY_SSH_FINGERPRINT: keys.ecdsa.fp }, inNamespace('no-ecdsa', [keys.ed25519]));
  assert.equal(noEcdsa.status, 1, noEcdsa.out);
  assert.match(noEcdsa.out, /FAIL host key: the server did not offer exactly one ecdsa-sha2-nistp256 host key/);
  assertSilent(noEcdsa.out, HOST, PORT, keys.ed25519.fp);

  const closed = runStep(PROBE, { TS_PROBE_HOST: HOST, DEPLOY_SSH_PORT: OTHER_PORT, DEPLOY_SSH_FINGERPRINT: keys.ecdsa.fp }, inNamespace('closed', null));
  assert.equal(closed.status, 1, closed.out);
  assert.match(closed.out, /FAIL tcp: the SSH port does not answer/);
  assertSilent(closed.out, HOST, OTHER_PORT, keys.ecdsa.fp);
});

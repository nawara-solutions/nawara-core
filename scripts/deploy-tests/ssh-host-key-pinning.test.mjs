// V2-A.3 A3.6: the production host-key pin, end to end, with SYNTHETIC keys only. The exact SSH client of the six production workflows
// (appleboy/ssh-action@0ff4204 runs drone-ssh 1.8.2, linux-amd64) connects to throwaway, unprivileged sshd instances on 127.0.0.1 whose
// host keys are generated for the test. It shows which host key that client negotiates (Go x/crypto prefers ECDSA, then RSA, then
// Ed25519), that a wrong pin fails during key exchange, before any authentication, and that an empty pin accepts any host key, which
// is why the guard step must stop the job first. The guard step itself runs as GitHub runs it. The binary is downloaded from the
// drone-ssh release and executed ONLY when its SHA-256 equals the pin below; it is never executed otherwise. Nothing reaches a network
// beyond that download and the loopback interface; no production address, credential, key or service is used. The negotiation tests are
// skipped where no sshd can be started or the release cannot be downloaded.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { HOST_KEY_GUARD_RUN } from '../lib/checks.mjs';

// The version the pinned action downloads (its entrypoint.sh: DRONE_SSH_VERSION 1.8.2) and the asset's SHA-256, equal in the release
// API's asset digest and in the release's checksums.txt (verified 2026-10-16).
const DRONE_SSH = 'drone-ssh-1.8.2-linux-amd64';
const DRONE_SSH_URL = `https://github.com/appleboy/drone-ssh/releases/download/v1.8.2/${DRONE_SSH}`;
const DRONE_SSH_SHA256 = '1e10a9972eef167d9ddbc39e1ba80f7d44a011b4a6bc4f6149434154d9b6bb24';
const PRODUCTION_WORKFLOWS = ['auth-service-deploy.yml', 'organization-service-deploy.yml', 'audit-service-deploy.yml', 'core-rabbitmq-provision.yml', 'auth-db-credential-rotate.yml', 'core-backup.yml'];
const SSHD = '/usr/sbin/sshd';
const USER = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const guardOf = (name) => {
  const doc = parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'));
  const steps = Object.values(doc.jobs).flatMap((j) => j.steps ?? []);
  return steps.find((s) => s.name === 'Require the pinned production host key');
};
const GUARD = guardOf('core-backup.yml');

let T; let binary; let skip = ''; let client;
const servers = {};
const keygen = (name, type) => {
  const r = spawnSync('ssh-keygen', ['-q', '-t', type, ...(type === 'rsa' ? ['-b', '3072'] : []), '-N', '', '-C', `synthetic-${name}`, '-f', join(T, name)]);
  assert.equal(r.status, 0, String(r.stderr));
  const fp = spawnSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', join(T, `${name}.pub`)], { encoding: 'utf8' }).stdout.split(' ')[1];
  return { path: join(T, name), priv: readFileSync(join(T, name), 'utf8'), pub: readFileSync(join(T, `${name}.pub`), 'utf8').trim(), fp };
};
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const listening = (p) => new Promise((resolve) => { const c = connect(p, '127.0.0.1'); c.on('connect', () => { c.destroy(); resolve(true); }); c.on('error', () => resolve(false)); });

/** One unprivileged sshd offering exactly these host keys; its log is collected so a test can see whether anyone authenticated. */
async function startServer(name, hostKeys) {
  const port = await freePort();
  const config = [`Port ${port}`, 'ListenAddress 127.0.0.1', ...hostKeys.map((k) => `HostKey ${k.path}`), `PidFile ${join(T, `${name}.pid`)}`,
    `AuthorizedKeysFile ${join(T, 'authorized_keys')}`, 'PubkeyAuthentication yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM no', 'StrictModes no', `AllowUsers ${USER}`, 'LogLevel VERBOSE'];
  writeFileSync(join(T, `${name}.conf`), [...config, 'PerSourcePenalties no', ''].join('\n'));
  if (spawnSync(SSHD, ['-t', '-f', join(T, `${name}.conf`)]).status !== 0) writeFileSync(join(T, `${name}.conf`), [...config, ''].join('\n'));
  // -E: every per-connection line (OpenSSH 9.8+ logs them from sshd-session) goes to this file, not to syslog.
  const logPath = join(T, `${name}.log`);
  writeFileSync(logPath, '');
  const proc = spawn(SSHD, ['-D', '-E', logPath, '-f', join(T, `${name}.conf`)], { stdio: 'ignore' });
  const server = { port, proc, log: () => readFileSync(logPath, 'utf8') };
  for (let i = 0; i < 100 && !(await listening(port)); i++) await new Promise((r) => setTimeout(r, 30));
  if (!(await listening(port))) throw new Error(`sshd ${name} did not start`);
  return server;
}

/** The release binary, executed only after its SHA-256 matched the pin. */
async function verifiedBinary() {
  if (platform() !== 'linux' || arch() !== 'x64') return { skip: 'the pinned drone-ssh asset is linux-amd64' };
  let data;
  try {
    const res = await fetch(DRONE_SSH_URL, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { skip: `the drone-ssh release could not be downloaded (HTTP ${res.status})` };
    data = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { skip: `the drone-ssh release could not be downloaded (${e.name})` };
  }
  const got = sha256(data);
  // A mismatch is a failure, never a skip: the binary is not executed.
  if (got !== DRONE_SSH_SHA256) return { mismatch: got };
  const path = join(T, DRONE_SSH);
  writeFileSync(path, data, { mode: 0o700 });
  assert.equal(sha256(readFileSync(path)), DRONE_SSH_SHA256);
  return { path };
}

let downloaded;
before(async () => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'nawara-a36-')));
  chmodSync(T, 0o755);
  downloaded = await verifiedBinary();
  if (downloaded.mismatch) { skip = 'checksum mismatch'; return; }
  if (downloaded.skip) { skip = downloaded.skip; return; }
  binary = downloaded.path;
  if (!existsSync(SSHD)) { skip = 'OpenSSH server is required'; return; }
  client = keygen('client', 'ed25519');
  writeFileSync(join(T, 'authorized_keys'), `${client.pub}\n`, { mode: 0o600 });
  const ecdsa = keygen('host-ecdsa', 'ecdsa'); const rsa = keygen('host-rsa', 'rsa'); const ed25519 = keygen('host-ed25519', 'ed25519');
  try {
    servers.all = { ...(await startServer('all', [ed25519, rsa, ecdsa])), ecdsa, rsa, ed25519 };
    servers.noEcdsa = { ...(await startServer('no-ecdsa', [ed25519, rsa])), rsa, ed25519 };
    servers.ed25519Only = { ...(await startServer('ed25519-only', [ed25519])), ed25519 };
  } catch (e) {
    skip = e.message;
  }
});
after(() => { for (const s of Object.values(servers)) s.proc?.kill('SIGKILL'); if (T) rmSync(T, { recursive: true, force: true }); });

/** drone-ssh exactly as the action runs it (INPUT_* environment), with a synthetic key and a clean environment (no agent, no ~/.ssh). */
function connectWith(server, fingerprint) {
  const before = server.log().length;
  const env = { PATH: process.env.PATH, HOME: join(T, 'runner-home'), INPUT_HOST: '127.0.0.1', INPUT_PORT: String(server.port), INPUT_PROTOCOL: 'tcp',
    INPUT_USERNAME: USER, INPUT_KEY: client.priv, INPUT_FINGERPRINT: fingerprint, INPUT_TIMEOUT: '10s', INPUT_COMMAND_TIMEOUT: '30s',
    INPUT_SCRIPT: 'echo pinned-session-ok' };
  const r = spawnSync(binary, [], { env, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, serverLog: () => server.log().slice(before) };
}
const AUTH_ACTIVITY = /Accepted |Failed |Postponed |Invalid user|authenticat/i;
const settle = () => new Promise((resolve) => setTimeout(resolve, 300)); // sshd writes a connection's lines as it closes

test('A3.6: the drone-ssh binary is the pinned release asset (never executed on a checksum mismatch)', (t) => {
  if (downloaded?.mismatch) assert.fail(`drone-ssh checksum mismatch: got ${downloaded.mismatch}, pinned ${DRONE_SSH_SHA256}; the binary was not executed`);
  if (skip && !binary) return t.skip(skip);
  assert.equal(sha256(readFileSync(binary)), DRONE_SSH_SHA256);
  const v = spawnSync(binary, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(v.status, 0);
  assert.match(`${v.stdout}${v.stderr}`, /1\.8\.2/);
});

test('A3.6: ECDSA is negotiated when the server offers ECDSA, RSA and Ed25519', async (t) => {
  if (skip) return t.skip(skip);
  const s = servers.all;
  const ok = connectWith(s, s.ecdsa.fp);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /pinned-session-ok/);
  await settle();
  assert.match(ok.serverLog(), /Accepted publickey for /, 'control: the server log records an authentication when one happens');
  for (const other of [s.rsa.fp, s.ed25519.fp]) {
    const r = connectWith(s, other);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /host key fingerprint mismatch/);
  }
});

test('A3.6: RSA is negotiated when ECDSA is absent', (t) => {
  if (skip) return t.skip(skip);
  const s = servers.noEcdsa;
  const ok = connectWith(s, s.rsa.fp);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /pinned-session-ok/);
  const r = connectWith(s, s.ed25519.fp);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /host key fingerprint mismatch/);
});

test('A3.6: Ed25519 is negotiated when it is the only host key', (t) => {
  if (skip) return t.skip(skip);
  const s = servers.ed25519Only;
  const ok = connectWith(s, s.ed25519.fp);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /pinned-session-ok/);
});

test('A3.6: a mismatched pin fails during key exchange, before any authentication, and runs nothing', async (t) => {
  if (skip) return t.skip(skip);
  const s = servers.all;
  const wrong = keygen('unrelated', 'ecdsa').fp;
  const r = connectWith(s, wrong);
  await settle();
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /host key fingerprint mismatch/);
  assert.doesNotMatch(r.out, /pinned-session-ok/);
  const log = r.serverLog();
  assert.match(log, /Connection from 127\.0\.0\.1 port \d+/, 'the server saw the connection');
  assert.doesNotMatch(log, AUTH_ACTIVITY, 'no authentication was attempted, so no credential was sent');
});

test('A3.6: an EMPTY pin accepts any host key, which is why the guard step must stop the job first', (t) => {
  if (skip) return t.skip(skip);
  for (const s of [servers.all, servers.noEcdsa, servers.ed25519Only]) {
    const r = connectWith(s, '');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pinned-session-ok/);
  }
});

// ---------------------------------------------------------------- Core V2 M2 T7: why no connection setting may come from elsewhere
// The pinned drone-ssh reads every setting from PLUGIN_* and SSH_* before the action's INPUT_*, splits a comma-separated host into
// several targets, takes a port from a host:port value, and reads `host` from a `.host` file when no variable sets it. Each case below is
// shown against the synthetic loopback server; scripts/lib/checks.mjs refuses each source in every production SSH workflow, and the
// backup's destination check refuses any host value that is not exactly one tailnet IPv4 address.
function connectEnv(server, settings, cwd = T) {
  const env = { PATH: process.env.PATH, HOME: join(T, 'runner-home'), INPUT_PROTOCOL: 'tcp', INPUT_USERNAME: USER, INPUT_KEY: client.priv,
    INPUT_FINGERPRINT: server.ecdsa.fp, INPUT_TIMEOUT: '10s', INPUT_COMMAND_TIMEOUT: '30s', INPUT_SCRIPT: 'echo pinned-session-ok', ...settings };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const r = spawnSync(binary, [], { env, cwd, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const sessions = (out) => (out.match(/pinned-session-ok/g) ?? []).length;

test('T7: SSH_HOST and PLUGIN_HOST replace the action input host; SSH_PORT and PLUGIN_PORT replace its port', async (t) => {
  if (skip) return t.skip(skip);
  const s = servers.all;
  const closed = await freePort();
  // Control: the input alone points at an address where nothing listens, so the connection fails.
  assert.notEqual(connectEnv(s, { INPUT_HOST: '127.0.0.2', INPUT_PORT: String(s.port) }).code, 0);
  assert.notEqual(connectEnv(s, { INPUT_HOST: '127.0.0.1', INPUT_PORT: String(closed) }).code, 0);
  for (const override of ['SSH_HOST', 'PLUGIN_HOST']) {
    const r = connectEnv(s, { INPUT_HOST: '127.0.0.2', INPUT_PORT: String(s.port), [override]: '127.0.0.1' });
    assert.equal(r.code, 0, `${override}: ${r.out}`);
    assert.equal(sessions(r.out), 1, override);
  }
  for (const override of ['SSH_PORT', 'PLUGIN_PORT']) {
    const r = connectEnv(s, { INPUT_HOST: '127.0.0.1', INPUT_PORT: String(closed), [override]: String(s.port) });
    assert.equal(r.code, 0, `${override}: ${r.out}`);
  }
});

test('T7: a comma-separated host runs the script on every host, and a host:port value overrides the port', async (t) => {
  if (skip) return t.skip(skip);
  const s = servers.all;
  const list = connectEnv(s, { INPUT_HOST: '127.0.0.1,127.0.0.1', INPUT_PORT: String(s.port) });
  assert.equal(list.code, 0, list.out);
  assert.equal(sessions(list.out), 2, 'two targets, two sessions: a list is never a single destination');
  const suffixed = connectEnv(s, { INPUT_HOST: `127.0.0.1:${s.port}`, INPUT_PORT: String(await freePort()) });
  assert.equal(suffixed.code, 0, suffixed.out);
});

test('T7: a .host file in the working directory chooses the host when no variable sets one; the action always sets INPUT_HOST', (t) => {
  if (skip) return t.skip(skip);
  const s = servers.all;
  const dir = mkdtempSync(join(T, 'checkout-'));
  writeFileSync(join(dir, '.host'), '127.0.0.1');
  const fromFile = connectEnv(s, { INPUT_PORT: String(s.port) }, dir);
  assert.equal(fromFile.code, 0, `the file is read when no host variable exists: ${fromFile.out}`);
  const inputWins = connectEnv(s, { INPUT_HOST: '127.0.0.2', INPUT_PORT: String(s.port) }, dir);
  assert.notEqual(inputWins.code, 0, 'INPUT_HOST (always set by the composite action) takes precedence over the file');
});

// ---------------------------------------------------------------- the guard step, as GitHub runs a `run:` step (bash -e, pipefail)
function runGuard(value) {
  const env = { PATH: process.env.PATH };
  if (value !== undefined) env.DEPLOY_SSH_FINGERPRINT = value;
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', GUARD.run], { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const VALID = `SHA256:${'Ab3+/'.repeat(8)}xyz`;

test('A3.6: the six production workflows carry the identical guard, equal to the repository rule', () => {
  assert.equal(VALID.length, 'SHA256:'.length + 43);
  for (const name of PRODUCTION_WORKFLOWS) {
    const g = guardOf(name);
    assert.ok(g, name);
    assert.equal(g.env.DEPLOY_SSH_FINGERPRINT, '${{ secrets.DEPLOY_SSH_FINGERPRINT }}', name);
    assert.equal(g.run, GUARD.run, name);
    assert.deepEqual(g.run.split('\n').map((l) => l.trim()).filter(Boolean), HOST_KEY_GUARD_RUN, name);
  }
});

test('A3.6: the guard refuses a missing, empty or malformed fingerprint and prints no value', () => {
  const malformed = ['', ' ', 'SHA256:', `SHA256:${'A'.repeat(42)}`, `SHA256:${'A'.repeat(44)}`, `sha256:${'A'.repeat(43)}`, `MD5:${'A'.repeat(43)}`,
    `${'A'.repeat(43)}`, `SHA256:${'A'.repeat(42)}=`, `SHA256:${'A'.repeat(42)}-`, `${VALID}\n`, ` ${VALID}`, `${VALID} `, `SHA256:${'A'.repeat(43)}\nSHA256:${'B'.repeat(43)}`];
  for (const value of [undefined, ...malformed]) {
    const r = runGuard(value);
    assert.equal(r.code, 1, JSON.stringify(value));
    assert.match(r.out, /::error::DEPLOY_SSH_FINGERPRINT is missing or is not a SHA256 host-key fingerprint; nothing was sent to the server/);
    if (value && value.trim()) assert.ok(!r.out.includes(value.trim()), 'the guard never prints the value');
  }
});

test('A3.6: the guard accepts a well-formed SHA256 fingerprint, including real ssh-keygen output', (t) => {
  const r = runGuard(VALID);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, '');
  if (!client) return t.skip('no synthetic key was generated');
  for (const fp of [client.fp, servers.all?.ecdsa?.fp, servers.all?.rsa?.fp].filter(Boolean)) assert.equal(runGuard(fp).code, 0, fp);
});

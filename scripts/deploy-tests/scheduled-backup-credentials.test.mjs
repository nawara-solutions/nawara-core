// Core V2 M2 E3: the credential contract of the scheduled backup, end to end, with SYNTHETIC credentials only. The real step script of
// .github/workflows/core-backup-scheduled.yml runs with real OpenSSH against a throwaway, unprivileged sshd on 127.0.0.1, whose one
// authorized_keys line is the template's `restrict,command=` form. The forced command is the real entry script
// (infra/backup/scheduled-backup.sh) in a disposable installation with a recording stand-in for backup.sh, as in scheduled-backup.test.mjs;
// a two-line wrapper only points HOME at the disposable home. Every key here is generated for the test and deleted after it. Nothing
// reaches a network beyond the loopback interface, a database, GitHub or production. Skipped where no sshd can be started.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const WORKFLOW = parse(readFileSync(new URL('../../.github/workflows/core-backup-scheduled.yml', import.meta.url), 'utf8'));
const STEP = WORKFLOW.jobs.backup.steps[0];
const ENTRY = readFileSync(new URL('../../infra/backup/scheduled-backup.sh', import.meta.url), 'utf8');
const TEMPLATE = readFileSync(new URL('../../infra/backup/scheduled-backup.authorized_keys.template', import.meta.url), 'utf8');
const SECRETS = ['BACKUP_SSH_HOST', 'BACKUP_SSH_PORT', 'BACKUP_SSH_USER', 'BACKUP_SSH_KEY', 'BACKUP_SSH_KNOWN_HOSTS'];
const SSHD = '/usr/sbin/sshd';
const USER = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const FAKE_BACKUP = '#!/usr/bin/env bash\n{ echo "args=$#"; [ -t 0 ] && echo tty=yes || echo tty=no; env | sort; } >"$HOME/backup-ran"\necho "[backup] stand-in run: services=$BACKUP_SERVICES"\n';

let T; let sshd; let port; let skip = '';
const key = (name) => {
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `synthetic-${name}`, '-f', join(T, name)]);
  assert.equal(r.status, 0, String(r.stderr));
  return { priv: readFileSync(join(T, name), 'utf8'), pub: readFileSync(join(T, `${name}.pub`), 'utf8').trim(), path: join(T, name) };
};
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const listening = (p) => new Promise((resolve) => { const c = connect(p, '127.0.0.1'); c.on('connect', () => { c.destroy(); resolve(true); }); c.on('error', () => resolve(false)); });

let hostKey; let clientKey; let otherKey; let HOME;
before(async () => {
  if (!existsSync(SSHD) || spawnSync('ssh', ['-V']).status !== 0) { skip = 'OpenSSH client and server are required'; return; }
  T = realpathSync(mkdtempSync(join(tmpdir(), 'nawara-e3-')));
  chmodSync(T, 0o755);
  hostKey = key('host'); clientKey = key('client'); otherKey = key('other');

  // The disposable installation (B1 test pattern): real entry, pins substituted, stand-in backup.sh.
  HOME = join(T, 'home');
  mkdirSync(join(HOME, 'nawara-core', 'backup'), { recursive: true, mode: 0o700 });
  const dir = join(T, 'libexec', 'nawara-core-backup');
  mkdirSync(dir, { recursive: true });
  let entry = ENTRY.replace("readonly INSTALL_DIR='/usr/local/libexec/nawara-core-backup'", `readonly INSTALL_DIR='${dir}'`)
    .replace('readonly OWNER_UID=0', `readonly OWNER_UID=${process.getuid()}`)
    .replace(/readonly BACKUP_SH_SHA256='[0-9a-f]{64}'/, `readonly BACKUP_SH_SHA256='${sha256(FAKE_BACKUP)}'`);
  writeFileSync(join(dir, 'scheduled-backup.sh'), entry, { mode: 0o555 });
  writeFileSync(join(dir, 'backup.sh'), FAKE_BACKUP, { mode: 0o444 });
  chmodSync(join(T, 'libexec'), 0o755); chmodSync(dir, 0o755);
  const forced = join(T, 'forced');
  writeFileSync(forced, `#!/bin/sh\nexec env HOME='${HOME}' '${dir}/scheduled-backup.sh'\n`, { mode: 0o555 });

  // The template's line, with the synthetic public key and the wrapper as the forced command.
  const line = TEMPLATE.split('\n').find((l) => l.startsWith('restrict,'))
    .replace('/usr/local/libexec/nawara-core-backup/scheduled-backup.sh', forced)
    .replace('REPLACE_WITH_THE_SCHEDULED_BACKUP_PUBLIC_KEY', clientKey.pub.split(' ')[1]);
  writeFileSync(join(T, 'authorized_keys'), `${line}\n`, { mode: 0o600 });

  port = await freePort();
  const config = [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey.path}`, `PidFile ${join(T, 'sshd.pid')}`,
    `AuthorizedKeysFile ${join(T, 'authorized_keys')}`, 'PubkeyAuthentication yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM no', 'StrictModes no', 'PermitUserEnvironment no', `AllowUsers ${USER}`, 'MaxStartups 100', 'LogLevel VERBOSE',
    'Subsystem sftp internal-sftp'];  // as a stock sshd_config defines it: the forced command still wins
  // OpenSSH 9.8+ penalises a source address after failed logins; this test fails logins on purpose, all from 127.0.0.1.
  writeFileSync(join(T, 'sshd_config'), [...config, 'PerSourcePenalties no', ''].join('\n'));
  if (spawnSync(SSHD, ['-t', '-f', join(T, 'sshd_config')]).status !== 0) writeFileSync(join(T, 'sshd_config'), [...config, ''].join('\n'));
  sshd = spawn(SSHD, ['-D', '-e', '-f', join(T, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
  sshd.stderr.on('data', () => {});
  for (let i = 0; i < 100 && !(await listening(port)); i++) await new Promise((r) => setTimeout(r, 30));
  if (!(await listening(port))) skip = 'the unprivileged sshd did not start';
});
after(() => { sshd?.kill('SIGKILL'); if (T) rmSync(T, { recursive: true, force: true }); });

const knownHost = (k = hostKey, name = `[127.0.0.1]:${port}`) => `${name} ${k.pub.split(' ').slice(0, 2).join(' ')}`;
const secrets = (over = {}) => ({ BACKUP_SSH_HOST: '127.0.0.1', BACKUP_SSH_PORT: String(port), BACKUP_SSH_USER: USER,
  BACKUP_SSH_KEY: clientKey.priv, BACKUP_SSH_KNOWN_HOSTS: knownHost(), ...over });

/** Runs the workflow step as GitHub would (bash --noprofile --norc -eo pipefail), with the given secrets and a fresh RUNNER_TEMP. */
function runStep(values) {
  const runnerTemp = mkdtempSync(join(T, 'runner-'));
  rmSync(join(HOME, 'backup-ran'), { force: true });
  const env = { PATH: process.env.PATH, HOME: join(T, 'runner-home'), RUNNER_TEMP: runnerTemp };
  for (const [k, v] of Object.entries(values)) if (v !== undefined) env[k] = v;
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', STEP.run], { env, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, ran: existsSync(join(HOME, 'backup-ran')), leftover: readdirSync(runnerTemp) };
}
/** A direct client with the scheduled key, trying what an attacker holding the key would try. */
function client(args) {
  writeFileSync(join(T, 'kh'), `${knownHost()}\n`);
  rmSync(join(HOME, 'backup-ran'), { force: true });
  const r = spawnSync('ssh', ['-F', '/dev/null', '-i', clientKey.path, '-p', String(port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none', '-o', `UserKnownHostsFile=${join(T, 'kh')}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes',
    ...args], { encoding: 'utf8', timeout: 30000, input: '' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, ran: existsSync(join(HOME, 'backup-ran')) };
}

test('E3 contract: the workflow step reads exactly the five production-backup secrets, and no other secret', () => {
  assert.deepEqual(Object.keys(STEP.env).sort(), [...SECRETS].sort());
  for (const s of SECRETS) assert.equal(STEP.env[s], `\${{ secrets.${s} }}`);
  assert.equal(WORKFLOW.jobs.backup.environment, 'production-backup');
  assert.doesNotMatch(JSON.stringify(WORKFLOW), /DEPLOY_SSH|GITHUB_TOKEN|secrets\.(?!BACKUP_SSH_)/);
  assert.deepEqual(Object.keys(WORKFLOW.on), ['schedule'], 'no dispatch, push or pull_request trigger');
  assert.equal(WORKFLOW.jobs.backup.if, "github.ref == 'refs/heads/main' && vars.CORE_BACKUP_SCHEDULE == 'enabled'");
});

test('E3 contract: correct synthetic credentials start only the forced entry, which runs the pinned backup; nothing is left on the runner', (t) => {
  if (skip) return t.skip(skip);
  const r = runStep(secrets());
  assert.equal(r.code, 0, r.out);
  assert.ok(r.ran, 'the forced command ran the stand-in backup');
  assert.match(r.out, /\[scheduled-backup\] starting: services=auth-service organization-service/);
  assert.match(r.out, /\[scheduled-backup\] finished: exit 0/);
  const ran = readFileSync(join(HOME, 'backup-ran'), 'utf8');
  assert.match(ran, /^args=0$/m);
  assert.match(ran, /^tty=no$/m);
  assert.doesNotMatch(ran, /SSH_ORIGINAL_COMMAND|SSH_CONNECTION|BACKUP_SSH/);
  assert.deepEqual(r.leftover, [], 'the key and known_hosts files are removed from RUNNER_TEMP');
  assert.ok(!r.out.includes('PRIVATE KEY') && !r.out.includes(clientKey.pub.split(' ')[1]), 'no key material is printed');
});

test('E3 contract: a hashed known_hosts line for [host]:port is accepted, and so is a plain host line (this OpenSSH)', (t) => {
  if (skip) return t.skip(skip);
  // The runbook still requires [host]:port when the port is not 22: it is valid on every OpenSSH, the plain form is version-dependent.
  const plain = runStep(secrets({ BACKUP_SSH_KNOWN_HOSTS: knownHost(hostKey, '127.0.0.1') }));
  assert.equal(plain.code, 0, plain.out);
  const file = join(T, 'hashed');
  writeFileSync(file, `${knownHost()}\n`);
  assert.equal(spawnSync('ssh-keygen', ['-H', '-f', file]).status, 0);
  const r = runStep(secrets({ BACKUP_SSH_KNOWN_HOSTS: readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('|1|')) }));
  assert.equal(r.code, 0, r.out);
  assert.ok(r.ran);
});

test('E3 contract: a known_hosts value in the wrong form, or for another host key, fails closed before anything runs', (t) => {
  if (skip) return t.skip(skip);
  for (const [label, value] of [
    ['the bare host public key file (no host name)', hostKey.pub],
    ['another host name', knownHost(hostKey, '[127.0.0.2]:' + port)],
    ['another port', knownHost(hostKey, `[127.0.0.1]:${port + 1}`)],
    ['another host key', knownHost(otherKey)],
    ['a revoked marker', `@revoked ${knownHost()}`]]) {
    const r = runStep(secrets({ BACKUP_SSH_KNOWN_HOSTS: value }));
    assert.equal(r.code, 255, `${label}: ${r.out}`);
    assert.match(r.out, /Host key verification failed|REVOKED|host key .* not known|No ED25519 host key is known/i, label);
    assert.ok(!r.ran, `${label}: nothing ran`);
    assert.deepEqual(r.leftover, [], `${label}: nothing left on the runner`);
  }
});

test('E3 contract: a missing secret or a malformed port stops the job before any connection', (t) => {
  if (skip) return t.skip(skip);
  for (const name of SECRETS) {
    const r = runStep(secrets({ [name]: undefined }));
    assert.equal(r.code, 1, name);
    assert.match(r.out, new RegExp(`::error::${name} is not set in the production-backup environment`));
    assert.ok(!r.ran);
  }
  for (const value of ['22; id', '$(id)', '22 -oProxyCommand=id', 'abc']) {
    const r = runStep(secrets({ BACKUP_SSH_PORT: value }));
    assert.equal(r.code, 1, value);
    assert.match(r.out, /::error::BACKUP_SSH_PORT is not a port number/);
    assert.ok(!r.ran);
  }
});

test('E3 contract: a key that is not the authorized one fails without any password or interactive fallback', (t) => {
  if (skip) return t.skip(skip);
  const r = runStep(secrets({ BACKUP_SSH_KEY: otherKey.priv }));
  assert.equal(r.code, 255, r.out);
  assert.match(r.out, /Permission denied \(publickey\)/);
  assert.ok(!r.ran);
  const user = runStep(secrets({ BACKUP_SSH_USER: 'root' }));
  assert.equal(user.code, 255);
  assert.ok(!user.ran);
});

test('E3 contract: holding the key gives no shell, no command, no subsystem and no forwarding', (t) => {
  if (skip) return t.skip(skip);
  const marker = join(T, 'pwned');
  const target = [`${USER}@127.0.0.1`];
  const shell = client(['-tt', ...target, 'bash', '-i']);
  assert.match(shell.out, /PTY allocation request failed/, 'restrict grants no terminal');
  assert.notEqual(shell.code, 0);
  assert.ok(!shell.ran, 'a terminal request with a shell runs nothing');
  for (const [label, args] of [
    ['a command', ['-T', ...target, `touch ${marker}; sh -i`]],
    ['a shell without a terminal', ['-T', ...target, 'bash', '-i']],
    ['the sftp subsystem', ['-s', ...target, 'sftp']]]) {
    const r = client(args);
    assert.equal(r.code, 64, `${label}: ${r.out}`);
    // In subsystem mode the client does not display the server's stderr; the exit status 64 is the entry's refusal.
    if (args[0] !== '-s') assert.match(r.out, /REFUSED: a command or argument was sent with the scheduled-backup key; it is never run/, label);
    assert.ok(!r.ran && !existsSync(marker), `${label}: nothing ran`);
    assert.doesNotMatch(r.out, /touch|bash -i/, `${label}: the command text is never echoed`);
  }
  const pty = client(['-tt', ...target]);
  assert.match(pty.out, /PTY allocation request failed/, 'no terminal is granted');
  // Newer clients abort when the terminal is refused; older ones continue, and a session WITHOUT a command is the scheduled path:
  // it runs the forced entry (here the stand-in backup), never a shell, and never with a terminal.
  if (pty.ran) assert.match(readFileSync(join(HOME, 'backup-ran'), 'utf8'), /^args=0\ntty=no$/m, 'only the forced entry, without a terminal');
  const forward = client(['-N', '-o', 'ExitOnForwardFailure=yes', '-R', '0:127.0.0.1:9', ...target]);
  assert.equal(forward.code, 255, forward.out);
  assert.match(forward.out, /remote port forwarding failed/i);
  assert.ok(!forward.ran);
});

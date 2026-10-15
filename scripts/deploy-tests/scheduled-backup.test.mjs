// Core V2 M2 B1: infra/backup/scheduled-backup.sh, the forced-command entry of the scheduled backup, run for real (bash, flock, stat,
// sha256sum) against a disposable installation in a temporary directory. backup.sh is replaced by a recording stand-in, so the pin, the
// install directory and the expected owner are substituted in a copy of the script; the repository's own pins are checked separately
// (and by scripts/check-repo.mjs). Nothing here reaches a network, a database or production.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = readFileSync(new URL('../../infra/backup/scheduled-backup.sh', import.meta.url), 'utf8');
const BACKUP_SH = readFileSync(new URL('../../infra/backup/backup.sh', import.meta.url), 'utf8');
const ENTRY_PATH = new URL('../../infra/backup/scheduled-backup.sh', import.meta.url).pathname;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const UID = process.getuid();
const ROOTS = [];
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

/** A recording stand-in for backup.sh: what it received, then the exit code the test asks for. */
const FAKE_BACKUP = `#!/usr/bin/env bash
env | sort >"$HOME/fake-env"
printf '%s\\n' "$#" >"$HOME/fake-args"
echo "[backup] stand-in run: services=$BACKUP_SERVICES"
exit "$(cat "$HOME/fake-rc" 2>/dev/null || echo 0)"
`;

const swap = (text, from, to) => {
  assert.ok(text.includes(from), `fixture drift: "${from}" not found`);
  return text.replace(from, to);
};

/** A disposable installation: HOME with the backup working directory, and the install directory outside it (unless asked otherwise). */
function install({ insideWorkDir = false, ownerUid = UID, path, backup = FAKE_BACKUP, modes = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nawara-b1-')));
  ROOTS.push(root);
  const home = join(root, 'home');
  mkdirSync(join(home, 'nawara-core', 'backup'), { recursive: true, mode: 0o700 });
  const dir = insideWorkDir ? join(home, 'nawara-core', 'backup', 'bin') : join(root, 'libexec', 'nawara-core-backup');
  mkdirSync(dir, { recursive: true });
  let entry = swap(ENTRY, "readonly INSTALL_DIR='/usr/local/libexec/nawara-core-backup'", `readonly INSTALL_DIR='${dir}'`);
  entry = swap(entry, 'readonly OWNER_UID=0', `readonly OWNER_UID=${ownerUid}`);
  entry = swap(entry, /readonly BACKUP_SH_SHA256='[0-9a-f]{64}'/.exec(ENTRY)[0], `readonly BACKUP_SH_SHA256='${sha256(FAKE_BACKUP)}'`);
  if (path) entry = swap(entry, "PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'", `PATH='${path}'`);
  writeFileSync(join(dir, 'scheduled-backup.sh'), entry);
  writeFileSync(join(dir, 'backup.sh'), backup);
  chmodSync(join(dir, 'scheduled-backup.sh'), modes.entry ?? 0o555);
  chmodSync(join(dir, 'backup.sh'), modes.backup ?? 0o444);
  chmodSync(dir, modes.dir ?? 0o755);
  return { root, home, dir, entry: join(dir, 'scheduled-backup.sh') };
}

/** Runs the entry as sshd's forced command would: no arguments, the session's environment (with client-chosen extras). */
function run(w, { env = {}, args = [], script = w.entry } = {}) {
  const r = spawnSync(script, args, {
    env: { HOME: w.home, PATH: process.env.PATH, LC_ALL: 'C', BACKUP_DIR: join(w.root, 'elsewhere'), NAWARA_STATE_ROOT: join(w.root, 'elsewhere'), CLIENT_CHOSEN: 'x', ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr, ran: existsSync(join(w.home, 'fake-env')) };
}

test('B1 entry: runs the pinned backup.sh for exactly Auth and Organization, with no argument and no inherited environment', () => {
  const w = install();
  const r = run(w);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ran);
  assert.match(r.out, /\[scheduled-backup\] starting: services=auth-service organization-service backup\.sh sha256=[0-9a-f]{64}/);
  assert.match(r.out, /\[backup\] stand-in run: services=auth-service organization-service/);
  assert.match(r.out, /\[scheduled-backup\] finished: exit 0/);
  assert.equal(readFileSync(join(w.home, 'fake-args'), 'utf8').trim(), '0');
  const names = readFileSync(join(w.home, 'fake-env'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')[0]);
  assert.deepEqual(names.filter((n) => !['PWD', 'SHLVL', '_'].includes(n)).sort(), ['BACKUP_SERVICES', 'HOME', 'PATH']);
  const env = readFileSync(join(w.home, 'fake-env'), 'utf8');
  assert.match(env, new RegExp(`^HOME=${w.home}$`, 'm'));
  assert.match(env, /^PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m);
  assert.doesNotMatch(env, /BACKUP_DIR|NAWARA_STATE_ROOT|CLIENT_CHOSEN|LC_ALL|SSH_ORIGINAL_COMMAND/);
  assert.equal(r.err, '');
});

test('B1 entry: propagates backup.sh exit codes 1 (a backup failed) and 3 (retention failed), and releases the lock', () => {
  for (const code of [1, 3, 0]) {
    const w = install();
    writeFileSync(join(w.home, 'fake-rc'), `${code}\n`);
    assert.equal(run(w).code, code);
    rmSync(join(w.home, 'fake-env'));
    assert.equal(run(w).code, code, 'a second run is not blocked: the lock was released');
  }
});

test('B1 entry: a client command is refused (64) and never run, and its text is never printed', () => {
  const w = install();
  const marker = join(w.root, 'pwned');
  const r = run(w, { env: { SSH_ORIGINAL_COMMAND: `touch ${marker}; rm -rf ${w.home}` } });
  assert.equal(r.code, 64);
  assert.match(r.err, /REFUSED: a command or argument was sent with the scheduled-backup key; it is never run/);
  assert.ok(!existsSync(marker));
  assert.ok(!r.ran, 'backup.sh did not run');
  assert.doesNotMatch(r.out + r.err, /touch|rm -rf/);
  assert.equal(run(w, { args: ['--now'] }).code, 64, 'an argument is refused too');
});

test('B1 entry: a second run while one holds the lock is refused (75) and does nothing', async () => {
  const w = install();
  const lock = join(w.home, 'nawara-core', '.scheduled-backup.lock');
  const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && spawnSync('flock', ['-n', lock, 'true']).status === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.notEqual(spawnSync('flock', ['-n', lock, 'true']).status, 0, 'the holder has the lock');
    const r = run(w);
    assert.equal(r.code, 75);
    assert.match(r.err, /REFUSED: another scheduled-backup run holds the lock; nothing was done/);
    assert.ok(!r.ran);
  } finally {
    holder.kill('SIGKILL');
  }
});

test('B1 entry: an installed backup.sh that does not match the pin is refused (66) and not run', () => {
  const w = install({ backup: `${FAKE_BACKUP}# changed\n` });
  const r = run(w);
  assert.equal(r.code, 66);
  assert.match(r.err, /the installed backup\.sh does not match the pinned SHA-256/);
  assert.ok(!r.ran);
});

test('B1 entry: an installation inside the backup working directory is refused (65)', () => {
  const w = install({ insideWorkDir: true });
  const r = run(w);
  assert.equal(r.code, 65);
  assert.match(r.err, /lies inside the backup working directory/);
  assert.ok(!r.ran);
});

test('B1 entry: running from anywhere but the install directory is refused (65), including the repository checkout', () => {
  const w = install();
  const copy = join(w.root, 'copy.sh');
  copyFileSync(w.entry, copy);
  chmodSync(copy, 0o555);
  const r = run(w, { script: copy });
  assert.equal(r.code, 65);
  assert.match(r.err, /this script must run from/);
  const checkout = run(w, { script: ENTRY_PATH });
  assert.equal(checkout.code, 65, 'the repository copy never runs: it is not the installed one');
  assert.ok(!r.ran && !checkout.ran);
});

test('B1 entry: a symbolic link for backup.sh or the install directory is refused (65)', () => {
  const w = install();
  const real = join(w.root, 'real-backup.sh');
  writeFileSync(real, FAKE_BACKUP, { mode: 0o444 });
  chmodSync(w.dir, 0o755);
  rmSync(join(w.dir, 'backup.sh'));
  symlinkSync(real, join(w.dir, 'backup.sh'));
  assert.match(run(w).err, /backup\.sh is a symbolic link/);

  const v = install();
  const linked = join(v.root, 'linked-libexec');
  symlinkSync(v.dir, linked);
  const entry = readFileSync(v.entry, 'utf8').replace(`readonly INSTALL_DIR='${v.dir}'`, `readonly INSTALL_DIR='${linked}'`);
  chmodSync(v.entry, 0o755);
  writeFileSync(v.entry, entry);
  chmodSync(v.entry, 0o555);
  const r = run(v, { script: join(linked, 'scheduled-backup.sh') });
  assert.equal(r.code, 65);
  assert.match(r.err, /must be a real directory path \(no symbolic link\)/);
});

test('B1 entry: the wrong owner, or a file or directory writable by group or others, is refused (65)', () => {
  const owner = install({ ownerUid: UID + 1 });
  assert.match(run(owner).err, /must be owned by uid/);
  for (const [modes, re] of [[{ backup: 0o464 }, /backup\.sh must not be writable by group or others \(mode 464\)/],
    [{ entry: 0o557 }, /scheduled-backup\.sh must not be writable by group or others/],
    [{ dir: 0o775 }, /nawara-core-backup must not be writable by group or others \(mode 775\)/]]) {
    const w = install({ modes });
    const r = run(w);
    assert.equal(r.code, 65, JSON.stringify(modes));
    assert.match(r.err, re);
    assert.ok(!r.ran);
  }
});

test('B1 entry: a missing tool is refused (69), and a missing HOME is refused (65)', () => {
  const shims = realpathSync(mkdtempSync(join(tmpdir(), 'nawara-b1-shims-')));
  ROOTS.push(shims);
  for (const tool of ['bash', 'env', 'sha256sum', 'stat', 'readlink', 'dirname', 'cat', 'sort']) {
    const at = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(at, join(shims, tool));
  }
  const w = install({ path: shims });
  const r = run(w);
  assert.equal(r.code, 69);
  assert.match(r.err, /flock is required on the server; nothing was done/);
  const v = install();
  assert.equal(run(v, { env: { HOME: join(v.root, 'missing') } }).code, 65);
});

test('B1 entry: the repository script carries the real pins and no private-key marker', () => {
  assert.equal(/readonly BACKUP_SH_SHA256='([0-9a-f]{64})'/.exec(ENTRY)[1], sha256(BACKUP_SH));
  assert.match(ENTRY, /^readonly INSTALL_DIR='\/usr\/local\/libexec\/nawara-core-backup'$/m);
  assert.match(ENTRY, /^readonly OWNER_UID=0$/m);
  assert.match(ENTRY, /^readonly SERVICES='auth-service organization-service'$/m);
  assert.doesNotMatch(ENTRY, /PRIVATE KEY/);
  assert.ok(BACKUP_SH.includes('PRIVATE KEY'), 'backup.sh refuses a private-key marker under its directory, and contains one itself: hence outside');
});

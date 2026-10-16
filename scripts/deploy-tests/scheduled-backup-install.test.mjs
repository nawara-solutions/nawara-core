// Core V2 M2 E2: infra/backup/verify-scheduled-backup-install.sh (the read-only console verification of the installation) and the
// entry's root refusal, run for real against a disposable installation in a temporary directory. sshd, ssh, getent and runuser are
// replaced by stand-ins on the script's fixed PATH (the stand-in sshd prints a chosen effective configuration; runuser runs the probe as
// the test user), and the root and owner pins are substituted, as in scheduled-backup.test.mjs. The ed25519 key is a throwaway generated
// here. Nothing here reaches a network, a database or production.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = readFileSync(new URL('../../infra/backup/scheduled-backup.sh', import.meta.url), 'utf8');
const VERIFIER = readFileSync(new URL('../../infra/backup/verify-scheduled-backup-install.sh', import.meta.url), 'utf8');
const TEMPLATE = readFileSync(new URL('../../infra/backup/scheduled-backup.authorized_keys.template', import.meta.url), 'utf8');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const UID = process.getuid();
const GID = process.getgid();
const USER = 'nawara-e2-test';
const FIXED_PATH = "PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'";
const ROOTS = [];
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

const FAKE_BACKUP = '#!/usr/bin/env bash\ntouch "$HOME/backup-ran"\n';
const SSHD_OK = { pubkeyauthentication: 'yes', strictmodes: 'yes', forcecommand: 'none', authorizedkeyscommand: 'none',
  permituserenvironment: 'no', authorizedkeysfile: '.ssh/authorized_keys .ssh/authorized_keys2' };

const swap = (text, from, to) => {
  assert.ok(text.includes(from), `fixture drift: "${from}" not found`);
  return text.replace(from, to);
};

/** The template's line with its placeholder replaced by a public key: exactly what the owner adds at E2. */
const scheduledLine = (blob) => TEMPLATE.split('\n').find((l) => l.startsWith('restrict,')).replace('REPLACE_WITH_THE_SCHEDULED_BACKUP_PUBLIC_KEY', blob);

/** A disposable installation, a runtime-user home with authorized_keys, and stand-ins for sshd, ssh, getent and runuser. */
function setup({ sshd = {}, openssh = '9.6', keys, entryText, modes = {}, extraFile = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nawara-e2-')));
  ROOTS.push(root);
  chmodSync(root, 0o755);
  const dir = join(root, 'usr', 'local', 'libexec', 'nawara-core-backup');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const d of [join(root, 'usr'), join(root, 'usr', 'local'), join(root, 'usr', 'local', 'libexec')]) chmodSync(d, 0o755);
  const home = join(root, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'nawara-core', 'backup'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o750);

  let entry = swap(ENTRY, "readonly INSTALL_DIR='/usr/local/libexec/nawara-core-backup'", `readonly INSTALL_DIR='${dir}'`);
  entry = swap(entry, 'readonly OWNER_UID=0', `readonly OWNER_UID=${UID}`);
  entry = swap(entry, /readonly BACKUP_SH_SHA256='[0-9a-f]{64}'/.exec(ENTRY)[0], `readonly BACKUP_SH_SHA256='${sha256(FAKE_BACKUP)}'`);
  if (entryText) entry = entryText(entry);
  writeFileSync(join(dir, 'scheduled-backup.sh'), entry);
  writeFileSync(join(dir, 'backup.sh'), FAKE_BACKUP);
  if (extraFile) writeFileSync(join(dir, 'notes.txt'), 'x');
  chmodSync(join(dir, 'scheduled-backup.sh'), modes.entry ?? 0o555);
  chmodSync(join(dir, 'backup.sh'), modes.backup ?? 0o444);
  chmodSync(dir, modes.dir ?? 0o755);

  const keygen = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'e2-test', '-f', join(root, 'key')]);
  assert.equal(keygen.status, 0, String(keygen.stderr));
  const blob = readFileSync(join(root, 'key.pub'), 'utf8').split(' ')[1];
  const fingerprint = spawnSync('ssh-keygen', ['-l', '-f', join(root, 'key.pub')], { encoding: 'utf8' }).stdout.split(' ')[1];
  // The template's line, pointing at the disposable install directory (as the real one points at the real one).
  const line = scheduledLine(blob).replace('/usr/local/libexec/nawara-core-backup', dir);
  const files = keys ? keys({ blob, line }) : { authorized_keys: `ssh-ed25519 ${'A'.repeat(68)} owner-console\n${line}\n` };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(home, '.ssh', name), text, { mode: 0o600 });

  const shims = join(root, 'shims');
  mkdirSync(shims);
  const config = Object.entries({ ...SSHD_OK, ...sshd }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v}`).join('\n');
  writeFileSync(join(root, 'sshd-T'), `${config}\n`);
  const shim = (name, body) => writeFileSync(join(shims, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  shim('sshd', `[ "$1" = -T ] && printf '%s\\n' "$*" >"${root}/sshd-args" && exec cat "${root}/sshd-T"; exit 1`);
  shim('ssh', `[ "$1" = -V ] && echo "OpenSSH_${openssh}p1 Debian, OpenSSL 3" >&2; exit 0`);
  shim('getent', `[ "$1 $2" = "passwd ${USER}" ] && echo "${USER}:x:${UID}:${GID}::${home}:/bin/bash" && exit 0; exit 2`);
  shim('id', `[ "$1 $2 $3" = "-nG -- ${USER}" ] && echo "${USER} docker" && exit 0; exec /usr/bin/id "$@"`);
  shim('runuser', `echo "$*" >>"${root}/runuser-calls"; [ "$1 $2 $3" = "-u ${USER} --" ] || exit 99; shift 3; exec "$@"`);

  let verifier = swap(VERIFIER, "readonly INSTALL_DIR='/usr/local/libexec/nawara-core-backup'", `readonly INSTALL_DIR='${dir}'`);
  verifier = swap(verifier, 'readonly OWNER_UID=0', `readonly OWNER_UID=${UID}`);
  verifier = swap(verifier, 'readonly OWNER_GID=0', `readonly OWNER_GID=${GID}`);
  verifier = swap(verifier, 'readonly RUN_AS_UID=0', `readonly RUN_AS_UID=${UID}`);
  verifier = swap(verifier, "readonly TRUST_ROOT='/'", `readonly TRUST_ROOT='${root}'`);
  verifier = swap(verifier, `readonly FORCED_OPTIONS='restrict,command="/usr/local/libexec/nawara-core-backup/scheduled-backup.sh"'`,
    `readonly FORCED_OPTIONS='restrict,command="${dir}/scheduled-backup.sh"'`);
  verifier = swap(verifier, FIXED_PATH, `PATH='${shims}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'`);
  const script = join(root, 'verify.sh');
  writeFileSync(script, verifier, { mode: 0o755 });
  return { root, dir, home, blob, fingerprint, script, entrySha: sha256(entry), runuserCalls: () => (existsSync(join(root, 'runuser-calls')) ? readFileSync(join(root, 'runuser-calls'), 'utf8') : '') };
}

function verify(w, args = [USER, w.entrySha]) {
  const r = spawnSync(w.script, args, { env: { PATH: process.env.PATH, HOME: w.home, LC_ALL: 'C' }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A snapshot of every file under the root (path, mode, size, content hash, mtime): the verifier must leave it identical. */
function snapshot(root) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      const s = statSync(p);
      out.push(`${p} ${s.mode} ${s.size} ${s.mtimeMs} ${e.isFile() ? sha256(readFileSync(p)) : ''}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.join('\n');
}

const installed = setup;

test('E2 verifier: a correct installation passes, prints the fingerprint but never the key, and changes nothing', () => {
  const w = installed();
  const before = snapshot(w.root);
  const r = verify(w);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /RESULT: PASS \(\d+ checks\); nothing was changed/);
  assert.doesNotMatch(r.out, /^FAIL/m);
  assert.ok(r.out.includes(`info  scheduled key fingerprint: ${w.fingerprint}`), r.out);
  assert.ok(!(r.out + r.err).includes(w.blob), 'the public key is never printed');
  assert.doesNotMatch(r.out + r.err, /owner-console|A{40}/, 'no other authorized_keys line is printed');
  assert.match(r.out, /ok    forced command: a client command is refused \(64\) and not run/);
  assert.match(r.out, /ok    forced command: an argument is refused \(64\) and not run/);
  assert.match(r.out, /info  runtime user groups: nawara-e2-test docker \(docker\/sudo membership is root-equivalent; not isolation/);
  const after = snapshot(w.root).split('\n').filter((l) => !/(sshd-args|runuser-calls) /.test(l)).join('\n');
  assert.equal(after, before.split('\n').filter((l) => !/(sshd-args|runuser-calls) /.test(l)).join('\n'), 'nothing under the installation or the home changed');
  assert.ok(!existsSync(join(w.home, 'backup-ran')), 'backup.sh never ran');
  assert.ok(!existsSync(join(w.home, 'nawara-core', '.scheduled-backup.lock')), 'the probe stops before the lock');
  assert.match(readFileSync(join(w.root, 'sshd-args'), 'utf8'), new RegExp(`-T -C user=${USER},host=scheduled-backup.invalid,addr=192.0.2.1`));
});

test('E2 verifier: an invalid invocation or a non-root caller is refused (2) before anything is checked', () => {
  const w = installed();
  for (const args of [[], [USER], [USER, w.entrySha, 'extra'], ['root;id', w.entrySha], ['', w.entrySha], [USER, 'abc'], [USER, w.entrySha.toUpperCase()]]) {
    const r = verify(w, args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /REFUSED: .*\nusage: verify-scheduled-backup-install\.sh <runtime-user> <entry-sha256>/);
    assert.equal(r.out, '');
  }
  const notRoot = installed();
  writeFileSync(notRoot.script, readFileSync(notRoot.script, 'utf8').replace(`readonly RUN_AS_UID=${UID}`, `readonly RUN_AS_UID=${UID + 1}`));
  const r = verify(notRoot);
  assert.equal(r.code, 2);
  assert.match(r.err, /run as root at the console/);
  assert.equal(notRoot.runuserCalls(), '');
});

test('E2 verifier: an entry that is not the reviewed revision fails, and the refusal is then never probed', () => {
  const w = installed();
  const r = verify(w, [USER, '0'.repeat(64)]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  entry: sha256 [0-9a-f]{64} does not match the reviewed revision 0{64}/);
  assert.match(r.out, /FAIL  forced command: refusal not probed/);
  assert.equal(w.runuserCalls(), '', 'nothing was run as the runtime user');
  assert.match(r.out, /RESULT: FAIL \(\d+ of \d+ checks failed\); nothing was changed; STOP/);
});

test('E2 verifier: a backup.sh that does not match the entry pin fails', () => {
  const w = installed();
  chmodSync(join(w.dir, 'backup.sh'), 0o644);
  writeFileSync(join(w.dir, 'backup.sh'), `${FAKE_BACKUP}# changed\n`);
  chmodSync(join(w.dir, 'backup.sh'), 0o444);
  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  backup\.sh: sha256 [0-9a-f]{64} does not match the entry's pin/);
  assert.equal(w.runuserCalls(), '');
});

test('E2 verifier: wrong modes, an extra file or a group-writable ancestor fail', () => {
  for (const [opts, re] of [[{ modes: { entry: 0o755 } }, /FAIL  mode: .*scheduled-backup\.sh must be a file .* with mode 555/],
    [{ modes: { backup: 0o644 } }, /FAIL  mode: .*backup\.sh must be a file .* with mode 444/],
    [{ modes: { dir: 0o775 } }, /FAIL  install path: .*nawara-core-backup must exist, be no symbolic link/],
    [{ extraFile: true }, /FAIL  install directory: must hold exactly backup\.sh and scheduled-backup\.sh \(found: backup\.sh notes\.txt scheduled-backup\.sh \)/]]) {
    const w = installed(opts);
    const r = verify(w);
    assert.equal(r.code, 1, JSON.stringify(opts));
    assert.match(r.out, re);
  }
  const w = installed();
  chmodSync(join(w.root, 'usr', 'local'), 0o777);
  assert.match(verify(w).out, /FAIL  install path: .*\/usr\/local must exist/);
  chmodSync(join(w.root, 'usr', 'local'), 0o755);
});

test('E2 verifier: the key without the forced command anywhere, or a second scheduled line, fails (it would bypass the restriction)', () => {
  const cases = [
    [({ blob, line }) => ({ authorized_keys: `${line}\nssh-ed25519 ${blob} admin\n` }), /FAIL  authorized_keys: the scheduled key appears on 2 lines/],
    [({ blob, line }) => ({ authorized_keys: `${line}\n`, authorized_keys2: `ssh-ed25519 ${blob} admin\n` }), /FAIL  authorized_keys: the scheduled key appears on 2 lines/],
    [({ line }) => ({ authorized_keys: `${line}\n${line}\n` }), /FAIL  authorized_keys: exactly one line must name the scheduled backup \(found 2\)/],
    [() => ({ authorized_keys: 'ssh-ed25519 AAAA owner\n' }), /FAIL  authorized_keys: exactly one line must name the scheduled backup \(found 0\)/],
    [({ line }) => ({ authorized_keys: `${line.replace('restrict,', 'restrict,pty,')}\n` }), /FAIL  authorized_keys: the scheduled line must be exactly/],
    [({ line }) => ({ authorized_keys: `${line.replace('restrict,', '')}\n` }), /FAIL  authorized_keys: the scheduled line must be exactly/],
    [({ line }) => ({ authorized_keys: `environment="X=1",${line}\n` }), /FAIL  authorized_keys: the scheduled line must be exactly/],
    [({ line }) => ({ authorized_keys: `${line.replace('ssh-ed25519 ', 'ssh-rsa ')}\n` }), /FAIL  authorized_keys: the scheduled line must be exactly/],
    [({ line }) => ({ authorized_keys: `${line}\n-----BEGIN OPENSSH PRIVATE KEY-----\n` }), /FAIL  authorized_keys: .* contains a private-key marker/],
  ];
  for (const [keys, re] of cases) {
    const w = installed({ keys });
    const r = verify(w);
    assert.equal(r.code, 1, String(keys));
    assert.match(r.out, re);
    assert.ok(!r.out.includes(w.blob), 'the key is never printed, even when the line is wrong');
  }
});

test('E2 verifier: a group-writable authorized_keys or .ssh directory fails', () => {
  const w = installed();
  chmodSync(join(w.home, '.ssh', 'authorized_keys'), 0o620);
  assert.match(verify(w).out, /FAIL  authorized_keys: .*authorized_keys must be no symbolic link, owned by the runtime user or root/);
  const v = installed();
  chmodSync(join(v.home, '.ssh'), 0o770);
  assert.match(verify(v).out, /FAIL  authorized_keys: .*\.ssh must be owned by the runtime user or root and not group\/other-writable/);
});

test('E2 verifier: an sshd that overrides or weakens the forced command, or an OpenSSH without restrict, fails', () => {
  for (const [sshd, re] of [[{ forcecommand: '/bin/bash' }, /FAIL  sshd: forcecommand must be none/],
    [{ authorizedkeyscommand: '/usr/bin/fetch-keys %u' }, /FAIL  sshd: authorizedkeyscommand must be none/],
    [{ pubkeyauthentication: 'no' }, /FAIL  sshd: pubkeyauthentication must be yes/],
    [{ permituserenvironment: 'yes' }, /FAIL  sshd: permituserenvironment must be no/],
    [{ strictmodes: 'no' }, /FAIL  sshd: strictmodes must be yes/],
    [{ authorizedkeysfile: 'none' }, /FAIL  authorized_keys: sshd names no AuthorizedKeysFile/]]) {
    const r = verify(installed({ sshd }));
    assert.equal(r.code, 1, JSON.stringify(sshd));
    assert.match(r.out, re);
  }
  assert.match(verify(installed({ openssh: '7.1' })).out, /FAIL  openssh: version 7\.1 does not support restrict/);
  assert.equal(verify(installed({ openssh: '7.2' })).code, 0);
  const absolute = installed({ sshd: { authorizedkeysfile: '%h/.ssh/authorized_keys' } });
  assert.equal(verify(absolute).code, 0, 'a %h token resolves to the runtime user home');
});

test('E2 verifier: an installed entry that does not refuse a client command fails the probe', () => {
  const w = installed({ entryText: (e) => swap(e, '|| refuse 64 "a command', '|| true "a command') });
  const r = verify(w);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  forced command: a client command was not refused with 64/);
  assert.match(w.runuserCalls(), new RegExp(`^-u ${USER} -- env -i HOME=`, 'm'));
});

test('E2 entry: run as root (uid 0 in a user namespace), the entry refuses (65) and runs nothing', (t) => {
  if (spawnSync('unshare', ['-r', 'true']).status !== 0) return t.skip('unprivileged user namespaces are not available');
  const w = installed();
  const entry = join(w.dir, 'scheduled-backup.sh');
  const r = spawnSync('unshare', ['-r', 'env', '-i', `HOME=${w.home}`, `PATH=${process.env.PATH}`, entry], { encoding: 'utf8' });
  assert.equal(r.status, 65, r.stderr);
  assert.match(r.stderr, /REFUSED: the scheduled backup never runs as root; its key belongs in the runtime user's authorized_keys/);
  assert.ok(!existsSync(join(w.home, 'backup-ran')));
  const asUser = spawnSync('env', ['-i', `HOME=${w.home}`, `PATH=${process.env.PATH}`, entry], { encoding: 'utf8' });
  assert.equal(asUser.status, 0, `the same installation runs as the (non-root) runtime user: ${asUser.stderr}`);
  assert.ok(existsSync(join(w.home, 'backup-ran')));
});

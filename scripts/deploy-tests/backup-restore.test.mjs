// Stage 21.x G5: infra/backup/backup.sh and infra/backup/restore-drill.sh against the fake docker CLI (pg_dump / pg_restore in the
// database container, the AWS CLI image as a private S3-compatible bucket) with the REAL openssl, tar and sha256sum. A throwaway key
// pair is generated outside the repository for these tests and removed afterwards. The real-PostgreSQL drill is recorded in
// docs/runbooks/core-backup-restore.md §7.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRIPTS, world } from './lib/harness.mjs';

const KEYS = mkdtempSync(join(tmpdir(), 'nawara-g5-test-keys-'));
const KEY = join(KEYS, 'recovery-key.pem');
const CERT = join(KEYS, 'recipient.pem');
const ED_CERT = join(KEYS, 'ed25519.pem');
before(() => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', KEY, '-out', CERT, '-days', '2', '-subj', '/CN=nawara-backup-test'], { stdio: 'ignore' });
  chmodSync(KEY, 0o600);
  // A certificate whose key cannot encrypt (Ed25519 signs only): a real `openssl cms -encrypt` failure.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-nodes', '-keyout', join(KEYS, 'ed.key'), '-out', ED_CERT, '-days', '2', '-subj', '/CN=nawara-backup-test-ed'], { stdio: 'ignore' });
});
after(() => rmSync(KEYS, { recursive: true, force: true }));

const PREFIX = 'nawara-core/prod';
const BUCKET = 'nawara-backups-test';
const hex = (seed) => seed.repeat(64).slice(0, 48);
const SECRETS = {
  pg: hex('a1'), app: hex('b2'), jwt: hex('c3'), broker: hex('d4'), migr: hex('e5'), orgApp: hex('f6'), token: hex('17'),
  awsId: 'AKIAFAKEBACKUPTEST01', awsSecret: hex('28'),
};
const DB_CONTAINER = (n) => ({ id: `id-${n}`, image: 'postgres:16-alpine', running: true, health: 'healthy', ports: [], publishAll: false, networks: {}, labels: [], mounts: [] });
const write = (p, text, mode = 0o600) => { writeFileSync(p, text, { mode }); chmodSync(p, mode); };

/** The production server: both databases, the services' secret files, and a configured backup destination. */
function backupWorld({ dbs = ['nawara-core-auth-db', 'nawara-core-organization-db'], dest = {}, creds, recipient = CERT, s3 = {}, backup = {} } = {}) {
  const w = world({ containers: Object.fromEntries(dbs.map((n) => [n, DB_CONTAINER(n)])), s3: { objects: {}, deleted: [], calls: [], ...s3 }, backup });
  const nc = join(w.home, 'nawara-core');
  const auth = join(nc, 'auth-service'); const org = join(nc, 'organization-service'); const bk = join(nc, 'backup');
  for (const d of [nc, auth, org, bk]) mkdirSync(d, { recursive: true, mode: 0o700 });
  write(join(auth, 'db.env'), `POSTGRES_USER=auth\nPOSTGRES_DB=auth\nPOSTGRES_PASSWORD=${SECRETS.pg}\nAUTH_APP_PASSWORD=${SECRETS.app}\n`);
  write(join(auth, '.env'), `NODE_ENV=production\nDATABASE_URL=postgres://auth_app:${SECRETS.app}@nawara-core-auth-db:5432/auth\nJWT_SECRET=${SECRETS.jwt}\nRABBITMQ_URL=amqp://auth-service:${SECRETS.broker}@nawara-core-rabbitmq:5672/nawara-core\nPAYMENT_SERVICE_URL=http://nawara-core-payment-service:3000\n`);
  write(join(org, 'db.env'), `POSTGRES_USER=organization_admin\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD=${SECRETS.pg}\n`);
  write(join(org, 'roles.env'), `ORGANIZATION_MIGRATOR_PASSWORD=${SECRETS.migr}\nORGANIZATION_APP_PASSWORD=${SECRETS.orgApp}\n`);
  write(join(org, '.env'), `NODE_ENV=production\nDATABASE_URL=postgres://organization_app:${SECRETS.orgApp}@nawara-core-organization-db:5432/organization\nRABBITMQ_URL=amqp://organization-service:${SECRETS.broker}@nawara-core-rabbitmq:5672/nawara-core\n`);
  mkdirSync(join(org, 'callers'), { mode: 0o700 }); write(join(org, 'callers', 'provisioning.token'), `${SECRETS.token}\n`);
  const d = { BACKUP_S3_ENDPOINT: 'https://objects.example.test', BACKUP_S3_BUCKET: BUCKET, BACKUP_S3_REGION: 'test-region-1', BACKUP_S3_PREFIX: PREFIX, ...dest };
  write(join(bk, 'destination.env'), Object.entries(d).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}\n`).join(''));
  write(join(bk, 's3-credentials.env'), creds ?? `AWS_ACCESS_KEY_ID=${SECRETS.awsId}\nAWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret}\n`);
  if (recipient) copyFileSync(recipient, join(bk, 'recipient.pem'));
  return { ...w, bk, backup: (services = 'auth-service', env = {}) => w.run(SCRIPTS.backup, { BACKUP_SERVICES: services, ...env }) };
}
const keysOf = (w) => Object.keys(w.state().s3.objects).map((k) => k.slice(BUCKET.length + 1)).sort();
const puts = (w) => w.state().s3.calls.filter((c) => c.op === 'put-object').map((c) => c.key);
const status = (w, svc, which) => readFileSync(join(w.bk, 'status', `${svc}.${which}`), 'utf8');
const workLeft = (w) => (existsSync(join(w.bk, 'work')) ? readdirSync(join(w.bk, 'work')) : []);
function decrypt(w, key, dir) {
  const enc = join(dir, 'x.cms'); const plain = join(dir, 'x.out');
  writeFileSync(enc, Buffer.from(w.state().s3.objects[`${BUCKET}/${key}`].data, 'base64'));
  execFileSync('openssl', ['cms', '-decrypt', '-binary', '-inform', 'DER', '-in', enc, '-inkey', KEY, '-out', plain], { stdio: 'ignore' });
  return readFileSync(plain);
}
const noLeak = (w, text) => { for (const s of Object.values(SECRETS)) assert.ok(!text.includes(s), 'no secret value in the output, argv or metadata'); };

// ---------------------------------------------------------------- backup: the whole flow
test('backup: dump in the container as the least-privileged identity, verified, encrypted, uploaded, HEAD-checked; manifest last; no plaintext left', () => {
  const w = backupWorld();
  const r = w.backup('auth-service');
  assert.equal(r.code, 0, r.out);
  const s = w.state();
  assert.deepEqual(s.dumps.map((d) => [d.container, d.argv]), [['nawara-core-auth-db', ['-U', 'auth_app', '-d', 'auth', '-Fc']]], 'pg_dump -Fc inside the database container (its own major) as auth_app');
  const keys = keysOf(w);
  assert.equal(keys.length, 4);
  const stamp = keys[0].match(/auth-service-(\d{8}T\d{6}Z)\./)[1];
  const base = `${PREFIX}/auth-service/auth-service-${stamp}`;
  assert.deepEqual(keys, [`${base}.config.tar.cms`, `${base}.db.dump.cms`, `${base}.facts.cms`, `${base}.manifest`]);
  assert.equal(puts(w).at(-1), `${base}.manifest`, 'the manifest is uploaded last: its presence marks a complete set');
  assert.deepEqual(s.s3.calls.filter((c) => c.op === 'head-object').map((c) => c.key), puts(w), 'every upload is verified remotely');
  // encrypted: the stored objects are CMS, and only the private key (never on the server) turns them back into the dump / archive
  const tmp = mkdtempSync(join(tmpdir(), 'nawara-g5-dec-'));
  try {
    assert.ok(!Buffer.from(s.s3.objects[`${BUCKET}/${base}.db.dump.cms`].data, 'base64').includes('PGDMP'), 'no plaintext dump is uploaded');
    assert.match(decrypt(w, `${base}.db.dump.cms`, tmp).toString(), /^PGDMP/);
    const tar = decrypt(w, `${base}.config.tar.cms`, tmp); writeFileSync(join(tmp, 'c.tar'), tar);
    const listing = execFileSync('tar', ['-tvf', join(tmp, 'c.tar')], { encoding: 'utf8' });
    assert.match(listing, /^-rw------- .* db\.env$/m); assert.match(listing, /^-rw------- .* \.env$/m);
    assert.match(decrypt(w, `${base}.facts.cms`, tmp).toString(), /-- nawara-backup-facts[\s\S]*-- nawara-backup-facts-results\ntable\|/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const manifest = Buffer.from(s.s3.objects[`${BUCKET}/${base}.manifest`].data, 'base64').toString();
  assert.match(manifest, /^format=nawara-core-backup\/1$/m); assert.match(manifest, /^postgres=16\.15$/m); assert.match(manifest, /^cipher=cms-aes-256-cbc$/m);
  for (const a of ['db.dump', 'config.tar', 'facts']) {
    const [, key, size, sha] = manifest.match(new RegExp(`^artifact\\.${a.split('.')[0]}=(\\S+) (\\d+) ([0-9a-f]{64})$`, 'm'));
    const obj = s.s3.objects[`${BUCKET}/${key}`];
    assert.equal(Number(size), obj.size); assert.equal(sha, obj.sha, 'the manifest records each encrypted object\'s size and sha256');
  }
  assert.doesNotMatch(manifest, /^table\||count/m, 'row counts stay inside the encrypted facts file');
  assert.match(status(w, 'auth-service', 'last-success'), new RegExp(`^stamp=${stamp}$`, 'm'));
  assert.match(status(w, 'auth-service', 'last-attempt'), /^result=succeeded$/m);
  assert.deepEqual(workLeft(w), [], 'no plaintext (or anything else) is left in the work directory');
  noLeak(w, r.out + JSON.stringify(s.calls) + manifest + status(w, 'auth-service', 'last-success'));
});

test('backup: organization-service dumps as organization_migrator (the owner, not a superuser) and archives callers/ with its modes', () => {
  const w = backupWorld();
  const r = w.backup('organization-service');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(w.state().dumps[0].argv, ['-U', 'organization_migrator', '-d', 'organization', '-Fc']);
  const key = keysOf(w).find((k) => k.endsWith('.config.tar.cms'));
  const tmp = mkdtempSync(join(tmpdir(), 'nawara-g5-dec-'));
  try {
    writeFileSync(join(tmp, 'c.tar'), decrypt(w, key, tmp));
    const listing = execFileSync('tar', ['-tvf', join(tmp, 'c.tar')], { encoding: 'utf8' });
    for (const f of ['db\\.env', 'roles\\.env', '\\.env', 'callers/provisioning\\.token']) assert.match(listing, new RegExp(`^-rw------- .* ${f}$`, 'm'));
    assert.match(listing, /^drwx------ .* callers\/$/m);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('backup: the S3 client is provider-neutral: the configured endpoint and region, credentials only through the env-file, a pinned image', () => {
  const w = backupWorld({ dest: { BACKUP_S3_ENDPOINT: 'https://s3.any-provider.test:9443', BACKUP_S3_REGION: 'auto' } });
  assert.equal(w.backup().code, 0);
  for (const c of w.state().s3.calls) {
    assert.equal(c.endpoint, 'https://s3.any-provider.test:9443');
    assert.ok(c.env.includes('AWS_DEFAULT_REGION=auto'));
    assert.deepEqual(c.envFiles, [join(w.bk, 's3-credentials.env')], 'credentials travel in the env-file only');
    assert.match(c.image, /^amazon\/aws-cli:[0-9.]+@sha256:[0-9a-f]{64}$/);
  }
  const script = readFileSync(SCRIPTS.backup, 'utf8');
  assert.doesNotMatch(script, /amazonaws\.com|r2\.cloudflarestorage|backblazeb2|wasabisys|digitaloceanspaces/i, 'no provider is hardcoded');
});

// ---------------------------------------------------------------- backup: every failure stops before anything reaches the bucket
for (const [label, backup, stage] of [
  ['pg_dump fails', { dumpFail: true }, 'dump'],
  ['the dump is empty', { dumpEmpty: true }, 'dump'],
  ['the dump is not a custom-format archive', { dumpNotCustom: true }, 'dump'],
  ['pg_restore --list cannot read the archive', { tocFail: true }, 'verify'],
  ['the archive has no data for a cutover-critical table', { tocMissing: 'schema_migrations' }, 'verify'],
  ['the restore facts cannot be read', { factsFail: true }, 'facts'],
]) {
  test(`backup: fail closed when ${label}: nothing is uploaded, no plaintext is left, the failure is recorded`, () => {
    const w = backupWorld({ backup });
    const r = w.backup();
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(puts(w), [], 'nothing reaches the bucket');
    assert.deepEqual(workLeft(w), []);
    assert.match(status(w, 'auth-service', 'last-attempt'), new RegExp(`^result=failed\nstage=${stage}$`, 'm'));
    assert.equal(existsSync(join(w.bk, 'status', 'auth-service.last-success')), false);
  });
}

test('backup: an encryption failure (a certificate whose key cannot encrypt) uploads nothing and removes the plaintext', () => {
  const w = backupWorld({ recipient: ED_CERT });
  const r = w.backup();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /encryption of db\.dump failed; nothing was uploaded/);
  assert.deepEqual(puts(w), []); assert.deepEqual(workLeft(w), []);
});

test('backup: a private key on the backup host is refused before anything is dumped (the host holds the public certificate only)', () => {
  const w = backupWorld();
  copyFileSync(KEY, join(w.bk, 'recovery-key.pem'));
  const r = w.backup();
  assert.equal(r.code, 1);
  assert.match(r.out, /a private key is present/);
  assert.equal(w.state().dumps, undefined, 'nothing was dumped');
});

for (const [label, s3, stage] of [
  ['the upload fails', { failPut: '.facts.cms' }, 'upload'],
  ['the remote size check disagrees', { badHead: '.config.tar.cms' }, 'upload'],
]) {
  test(`backup: fail closed when ${label}: the manifest is never uploaded (the set stays incomplete), no plaintext is left`, () => {
    const w = backupWorld({ s3 });
    const r = w.backup();
    assert.equal(r.code, 1, r.out);
    assert.ok(!keysOf(w).some((k) => k.endsWith('.manifest')), 'no manifest: a restore never picks this set');
    assert.match(status(w, 'auth-service', 'last-attempt'), new RegExp(`stage=${stage}`));
    assert.deepEqual(workLeft(w), []);
  });
}

test('backup: a missing database container fails that service only; the other service is still backed up (exit 1)', () => {
  const w = backupWorld({ dbs: ['nawara-core-auth-db'] });
  const r = w.backup('organization-service auth-service');
  assert.equal(r.code, 1);
  assert.match(r.out, /organization-service: database container nawara-core-organization-db not found/);
  assert.equal(keysOf(w).filter((k) => k.includes('/auth-service/')).length, 4);
});

for (const [label, over, reason] of [
  ['an unknown service', { services: 'billing-service' }, /unknown service 'billing-service'/],
  ['a plain-http endpoint', { dest: { BACKUP_S3_ENDPOINT: 'http://objects.example.test' } }, /must be an https:\/\/ endpoint/],
  ['a prefix that climbs', { dest: { BACKUP_S3_PREFIX: 'nawara/../other' } }, /BACKUP_S3_PREFIX/],
  ['an absolute prefix', { dest: { BACKUP_S3_PREFIX: '/nawara' } }, /BACKUP_S3_PREFIX/],
  ['an empty prefix (the whole bucket)', { dest: { BACKUP_S3_PREFIX: '' } }, /BACKUP_S3_PREFIX/],
  ['an invalid bucket', { dest: { BACKUP_S3_BUCKET: 'Bad_Bucket' } }, /BACKUP_S3_BUCKET/],
  ['no region', { dest: { BACKUP_S3_REGION: undefined } }, /BACKUP_S3_REGION is required/],
  ['credentials without the secret key', { creds: `AWS_ACCESS_KEY_ID=${SECRETS.awsId}\n` }, /must define AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/],
  ['no recipient certificate', { recipient: null }, /recipient certificate\) is missing/],
]) {
  test(`backup: refused before anything is dumped: ${label}`, () => {
    const { services, ...o } = over;
    const w = backupWorld(o);
    const r = w.backup(services);
    assert.equal(r.code, 1);
    assert.match(r.out, reason);
    assert.equal(w.state().dumps, undefined); assert.equal(w.state().s3.calls.length, 0);
    noLeak(w, r.out);
  });
}

test('backup: a credentials file readable by others is refused', () => {
  const w = backupWorld();
  chmodSync(join(w.bk, 's3-credentials.env'), 0o644);
  const r = w.backup();
  assert.equal(r.code, 1); assert.match(r.out, /must be mode 0600/);
});

// ---------------------------------------------------------------- retention (D3: 30 daily backups), confined to the prefix
const obj = (data = 'x') => ({ data: Buffer.from(data).toString('base64'), size: data.length, sha: '0'.repeat(64) });
function seeded(days, extra = {}) {
  const objects = {};
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    for (const ext of ['db.dump.cms', 'facts.cms', 'config.tar.cms', 'manifest']) objects[`${BUCKET}/${PREFIX}/auth-service/auth-service-${day}T021700Z.${ext}`] = obj();
  }
  for (const k of Object.keys(extra)) objects[`${BUCKET}/${k}`] = obj();
  return objects;
}
const LOOKALIKES = {
  [`${PREFIX}/organization-service/organization-service-20260101T021700Z.manifest`]: 1, // another service
  [`${PREFIX}/auth-service-evil/auth-service-20260101T021700Z.manifest`]: 1, // a look-alike prefix
  [`other/auth-service/auth-service-20260101T021700Z.manifest`]: 1, // outside the prefix
  [`${PREFIX}/auth-service/notes-20260101.txt`]: 1, // not an artifact name
  [`${PREFIX}/auth-service/auth-service-20260101T021700Z.manifest.bak`]: 1, // a near-miss name
  [`${PREFIX}/auth-service/auth-service-20260101T030000Z.db.dump.cms`]: 1, // an orphan (no manifest) of the oldest day
};

test('retention: 35 backup days -> keeps the newest 30 (plus the new one) and deletes only this service\'s artifacts older than them', () => {
  const w = backupWorld({ s3: { objects: seeded(35, LOOKALIKES) } });
  const r = w.backup();
  assert.equal(r.code, 0, r.out);
  const deleted = w.state().s3.deleted;
  // the new backup makes 36 days: the 6 oldest go (4 artifacts each), plus the orphan of the oldest day
  assert.equal(deleted.length, 6 * 4 + 1);
  for (const k of deleted) assert.match(k, new RegExp(`^${PREFIX}/auth-service/auth-service-2026010[1-6]T\\d{6}Z\\.(db\\.dump\\.cms|config\\.tar\\.cms|facts\\.cms|manifest)$`));
  const left = keysOf(w);
  for (const k of Object.keys(LOOKALIKES).filter((k) => !k.endsWith('T030000Z.db.dump.cms'))) assert.ok(left.includes(k), `never touched: ${k}`);
  const days = new Set(left.filter((k) => /^nawara-core\/prod\/auth-service\/auth-service-\d{8}T\d{6}Z\.manifest$/.test(k)).map((k) => k.match(/-(\d{8})T/)[1]));
  assert.equal(days.size, 30, 'exactly 30 backup days remain');
});

test('retention: with 30 days or fewer, nothing is deleted', () => {
  const w = backupWorld({ s3: { objects: seeded(28, LOOKALIKES) } });
  assert.equal(w.backup().code, 0);
  assert.deepEqual(w.state().s3.deleted, []);
});

test('retention: a listing failure after a successful backup exits 3; the new backup and every old one are intact', () => {
  const w = backupWorld({ s3: { objects: seeded(35), failList: true } });
  const r = w.backup();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /retention failed; the new backup is intact/);
  assert.deepEqual(w.state().s3.deleted, []);
  assert.equal(keysOf(w).length, 35 * 4 + 4);
  assert.match(status(w, 'auth-service', 'last-attempt'), /^result=succeeded$/m);
});

// ---------------------------------------------------------------- restore drill (the recovery environment: no production containers)
const IMAGE = `ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:${'ab'.repeat(32)}`;
const KNOWN = '00000000-0000-4000-8000-00000000u001'.replace('u', 'a');
/** A recovery environment holding the private key, read credentials for the bucket, and the objects a backup run uploaded. */
function recoveryWorld(fromBackup, { drill = {}, containers = {} } = {}) {
  const w = world({ containers, s3: { ...fromBackup.state().s3, calls: [], deleted: [] }, drill });
  const bk = join(w.home, 'recovery'); mkdirSync(bk, { mode: 0o700 });
  copyFileSync(join(fromBackup.bk, 'destination.env'), join(bk, 'destination.env'));
  copyFileSync(join(fromBackup.bk, 's3-credentials.env'), join(bk, 's3-credentials.env'));
  const key = join(w.home, 'key.pem'); copyFileSync(KEY, key); chmodSync(key, 0o600);
  const tmp = join(w.dir, 'tmp'); mkdirSync(tmp);
  const run = (env = {}) => w.run(SCRIPTS.restoreDrill, {
    SERVICE: 'auth-service', STAMP: 'latest', PRIVATE_KEY_FILE: key, IMAGE, KNOWN_ID: KNOWN, BACKUP_DIR: bk, TMPDIR: tmp, DRILL_ID: 'test', ...env,
  });
  return { ...w, run, tmp, key };
}
const backedUp = (svc = 'auth-service', backup = {}) => { const b = backupWorld({ backup }); assert.equal(b.backup(svc).code, 0); return b; };

test('restore drill: an isolated drill of the latest backup — no network, roles before the restore, the release\'s migrations, every check, then removed', () => {
  const w = recoveryWorld(backedUp());
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  const s = w.state();
  const db = s.runs.find((x) => x.name === 'nawara-drill-auth-service-test-db');
  assert.equal(db.network, 'none', 'the drill database has no network at all');
  assert.equal(db.image, 'postgres:16-alpine', 'the manifest\'s PostgreSQL major');
  const app = s.runs.find((x) => x.name === 'nawara-drill-auth-service-test-app');
  assert.equal(app.network, 'container:nawara-drill-auth-service-test-db', 'the service shares only the drill namespace');
  assert.ok(app.env.includes('RABBITMQ_URL=amqp://127.0.0.1:1/drill'), 'no broker is reachable, and no production broker URL is handed over');
  assert.ok(!app.env.some((e) => e.includes('nawara-core-rabbitmq') || e.includes(SECRETS.broker) || e.includes(SECRETS.app)), 'production endpoints and credentials are replaced');
  assert.ok(app.env.includes('JWT_SECRET=' + SECRETS.jwt), 'the restored secret files configure the service (they are part of what is verified)');
  assert.ok(app.env.includes('PAYMENT_SERVICE_URL=http://127.0.0.1:1'));
  const roleAt = s.stdin.find((x) => x.text.includes('CREATE ROLE auth_app')).at;
  const restore = s.restores[0];
  assert.equal(restore.container, 'nawara-drill-auth-service-test-db'); assert.ok(restore.argv.includes('--exit-on-error'));
  assert.ok(roleAt < restore.at, 'auth_app exists before pg_restore (its grants are in the archive)');
  const migrate = s.calls.findIndex((a) => a[0] === 'run' && a.includes('--rm') && a.includes('dist/cli/migrate.js'));
  assert.ok(restore.at < migrate, 'the release\'s own migration runner runs after the restore');
  assert.ok(s.calls[migrate].includes(IMAGE) && s.calls[migrate].includes('container:nawara-drill-auth-service-test-db'));
  assert.match(r.out, /PASS  7 restore facts equal the backup's/);
  assert.match(r.out, /OK  drill of auth-service \d{8}T\d{6}Z passed: 10 checks; drill containers removed; plaintext removed/);
  assert.equal(Object.keys(s.containers).filter((n) => n.startsWith('nawara-drill-')).length, 0, 'the drill containers are removed');
  assert.deepEqual(readdirSync(w.tmp), [], 'no decrypted file is left behind');
  noLeak(w, r.out);
});

test('restore drill: organization-service: the deploy\'s privilege assertion and the API known-id read', () => {
  const w = recoveryWorld(backedUp('organization-service'));
  const r = w.run({ SERVICE: 'organization-service', IMAGE: IMAGE.replace('auth', 'organization') });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS  the deploy's privilege assertion/);
  assert.match(r.out, /PASS  known-id read: GET \/organization\/companies\/<KNOWN_ID> returns the restored row/);
  const s = w.state();
  assert.ok(s.stdin.find((x) => x.text.includes('CREATE ROLE organization_migrator')).at < s.restores[0].at, 'roles and default privileges before the restore');
  const app = s.runs.find((x) => x.name.endsWith('-app'));
  assert.ok(app.env.some((e) => /^SERVICE_TOKENS=drill-reader:[0-9a-f]{64}$/.test(e)), 'a drill-only read credential, never a production token');
  assert.ok(!app.env.some((e) => e.includes(SECRETS.token)));
});

for (const [label, env, containers, reason] of [
  ['a Docker host running a production database', {}, { 'nawara-core-auth-db': DB_CONTAINER('nawara-core-auth-db') }, /runs nawara-core-auth-db: a drill belongs in the recovery environment/],
  ['an existing drill name', {}, { 'nawara-drill-auth-service-test-db': DB_CONTAINER('x') }, /already exists: a drill always starts from nothing/],
  ['an unknown service', { SERVICE: 'billing-service' }, {}, /unknown SERVICE/],
  ['an ambiguous stamp', { STAMP: 'yesterday' }, {}, /STAMP must be/],
  ['a known id that is not a UUID', { KNOWN_ID: "x'; DROP TABLE user; --" }, {}, /KNOWN_ID must be a lowercase UUID/],
  ['a drill id that could name a production container', { DRILL_ID: 'Core_DB' }, {}, /DRILL_ID must be/],
]) {
  test(`restore drill: refused before anything is created: ${label}`, () => {
    const w = recoveryWorld(backedUp(), { containers });
    const r = w.run(env);
    assert.equal(r.code, 1, r.out); assert.match(r.out, reason);
    assert.equal((w.state().runs ?? []).length, 0, 'no container was created');
  });
}

test('restore drill: a private key readable by others is refused', () => {
  const w = recoveryWorld(backedUp());
  chmodSync(w.key, 0o644);
  const r = w.run(); assert.equal(r.code, 1); assert.match(r.out, /PRIVATE_KEY_FILE must be mode 0600 or 0400/);
});

test('restore drill: a substituted object (sha256 differs from the manifest) is refused before decryption; nothing is created', () => {
  const b = backedUp();
  const k = Object.keys(b.state().s3.objects).find((x) => x.endsWith('.db.dump.cms'));
  b.patch((s) => { const o = s.s3.objects[k]; const d = Buffer.from(o.data, 'base64'); d[d.length - 1] ^= 1; o.data = d.toString('base64'); });
  const w = recoveryWorld(b);
  const r = w.run();
  assert.equal(r.code, 1); assert.match(r.out, /db\.dump\.cms does not match its manifest .* nothing was decrypted/);
  assert.equal((w.state().runs ?? []).length, 0); assert.deepEqual(readdirSync(w.tmp), []);
});

for (const [label, drill, reason] of [
  ['pg_restore --exit-on-error fails', { restoreFail: true }, /pg_restore --exit-on-error failed/],
  ['the runtime role is elevated after the restore', { roleAttrs: 't|t|f|f|f|f' }, /auth_app is not LOGIN NOSUPERUSER/],
  ['the runtime role can write schema_migrations', { smPrivileges: 't|t|f|f|f' }, /must hold SELECT only on schema_migrations/],
  ['a restored fact differs from the backup', { facts: 'table|company|2\n' }, /a restored fact differs from the backup \(table\|company\)/],
  ['the migration runner refuses the restored history', { migrateOutput: 'migration failed: 0004_x.sql was modified after it was applied' }, /refused the restored history/],
  ['the service never answers ready', { notReady: true }, /GET \/ready did not answer ready/],
]) {
  test(`restore drill: fail closed when ${label}; the drill is removed and no plaintext is left`, () => {
    const w = recoveryWorld(backedUp(), { drill });
    const r = w.run();
    assert.equal(r.code, 1, r.out); assert.match(r.out, reason);
    assert.equal(Object.keys(w.state().containers).filter((n) => n.startsWith('nawara-drill-')).length, 0);
    assert.deepEqual(readdirSync(w.tmp), []);
  });
}

test('restore drill: a later release restores an older backup: its extra migration applies on top of the restored history', () => {
  const w = recoveryWorld(backedUp(), { drill: { migrateOutput: 'migrations: 1 applied, 8 already applied', historyLength: 9, facts: `${'table|company|1\ntable|schema_migrations|8\n'}structure|constraints|41\nmigrations|9|ffff\nowner|company|x\nacl|company|x=r/x\nauthority|PREPARED|fresh|false\ntable|later_table|0\n` } });
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /8 already applied \(history restored\), 1 later migration\(s\) applied/);
});

test('restore drill: a restored history shorter than the backup\'s is refused', () => {
  const w = recoveryWorld(backedUp(), { drill: { migrateOutput: 'migrations: 1 applied, 7 already applied', historyLength: 7 } });
  const r = w.run();
  assert.equal(r.code, 1); assert.match(r.out, /the restored migration history is shorter than the backup's/);
});

test('restore drill: the organization known-id read must match the restored row', () => {
  const w = recoveryWorld(backedUp('organization-service'), { drill: { apiName: 'Another Co' } });
  const r = w.run({ SERVICE: 'organization-service' });
  assert.equal(r.code, 1); assert.match(r.out, /known-id read through the API does not match the restored row/);
});

test('restore drill: the organization privilege assertion is the deploy\'s (a forbidden privilege fails the drill)', () => {
  const w = recoveryWorld(backedUp('organization-service'));
  w.patch((s) => { s.org = { forbidden: 'ownership_state:UPDATE' }; });
  const r = w.run({ SERVICE: 'organization-service' });
  assert.equal(r.code, 1); assert.match(r.out, /organization_app holds forbidden privileges after the restore \(ownership_state:UPDATE\)/);
});

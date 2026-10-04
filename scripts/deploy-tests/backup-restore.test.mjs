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
  pg: hex('a1'), app: hex('b2'), jwt: hex('c3'), broker: hex('d4'), migr: hex('e5'), orgApp: hex('f6'), token: hex('17'), auditApp: hex('39'),
  awsId: 'AKIAFAKEBACKUPTEST01', awsSecret: hex('28'),
};
const DB_CONTAINER = (n) => ({ id: `id-${n}`, image: 'postgres:16-alpine', running: true, health: 'healthy', ports: [], publishAll: false, networks: {}, labels: [], mounts: [] });
const write = (p, text, mode = 0o600) => { writeFileSync(p, text, { mode }); chmodSync(p, mode); };

/** The production server: both databases, the services' secret files, and a configured backup destination. */
function backupWorld({ dbs = ['nawara-core-auth-db', 'nawara-core-organization-db', 'nawara-core-audit-db'], dest = {}, creds, recipient = CERT, s3 = {}, backup = {} } = {}) {
  const w = world({ containers: Object.fromEntries(dbs.map((n) => [n, DB_CONTAINER(n)])), s3: { objects: {}, deleted: [], calls: [], ...s3 }, backup });
  const nc = join(w.home, 'nawara-core');
  const auth = join(nc, 'auth-service'); const org = join(nc, 'organization-service'); const audit = join(nc, 'audit-service'); const bk = join(nc, 'backup');
  for (const d of [nc, auth, org, audit, bk]) mkdirSync(d, { recursive: true, mode: 0o700 });
  write(join(auth, 'db.env'), `POSTGRES_USER=auth\nPOSTGRES_DB=auth\nPOSTGRES_PASSWORD=${SECRETS.pg}\nAUTH_APP_PASSWORD=${SECRETS.app}\n`);
  write(join(auth, '.env'), `NODE_ENV=production\nDATABASE_URL=postgres://auth_app:${SECRETS.app}@nawara-core-auth-db:5432/auth\nJWT_SECRET=${SECRETS.jwt}\nRABBITMQ_URL=amqp://auth-service:${SECRETS.broker}@nawara-core-rabbitmq:5672/nawara-core\nPAYMENT_SERVICE_URL=http://nawara-core-payment-service:3000\n`);
  write(join(org, 'db.env'), `POSTGRES_USER=organization_admin\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD=${SECRETS.pg}\n`);
  write(join(org, 'roles.env'), `ORGANIZATION_MIGRATOR_PASSWORD=${SECRETS.migr}\nORGANIZATION_APP_PASSWORD=${SECRETS.orgApp}\n`);
  write(join(org, '.env'), `NODE_ENV=production\nDATABASE_URL=postgres://organization_app:${SECRETS.orgApp}@nawara-core-organization-db:5432/organization\nRABBITMQ_URL=amqp://organization-service:${SECRETS.broker}@nawara-core-rabbitmq:5672/nawara-core\n`);
  mkdirSync(join(org, 'callers'), { mode: 0o700 }); write(join(org, 'callers', 'provisioning.token'), `${SECRETS.token}\n`);
  // V2 A13: audit-service's state, as its deploy writes it (no SERVICE_TOKENS / AUDIT_SERVICE_POLICY: reads are denied by default)
  write(join(audit, 'db.env'), `POSTGRES_USER=audit_admin\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD=${SECRETS.pg}\n`);
  write(join(audit, 'roles.env'), `AUDIT_MIGRATOR_PASSWORD=${SECRETS.migr}\nAUDIT_APP_PASSWORD=${SECRETS.auditApp}\n`);
  write(join(audit, '.env'), `NODE_ENV=production\nDATABASE_URL=postgres://audit_app:${SECRETS.auditApp}@nawara-core-audit-db:5432/audit\nRABBITMQ_URL=amqp://audit-service:${SECRETS.broker}@nawara-core-rabbitmq:5672/nawara-core\n`);
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
function seeded(days, extra = {}, svc = 'auth-service') {
  const objects = {};
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    for (const ext of ['db.dump.cms', 'facts.cms', 'config.tar.cms', 'manifest']) objects[`${BUCKET}/${PREFIX}/${svc}/${svc}-${day}T021700Z.${ext}`] = obj();
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
    SERVICE: 'auth-service', STAMP: 'latest', PRIVATE_KEY_FILE: key, IMAGE, BACKUP_DIR: bk, TMPDIR: tmp, DRILL_ID: 'test',
    ...(env.SERVICE === 'organization-service' ? { KNOWN_ID: KNOWN } : {}), ...env,
  });
  return { ...w, run, tmp, key };
}
const backedUp = (svc = 'auth-service', backup = {}) => { const b = backupWorld({ backup }); assert.equal(b.backup(svc).code, 0); return b; };
/** TG-1: nothing of the drill survives: no drill container, and no volume of one (the postgres image's anonymous data volume). */
function assertDrillGone(w) {
  const s = w.state();
  assert.equal(Object.keys(s.containers).filter((n) => n.startsWith('nawara-drill-')).length, 0, 'no drill container is left');
  assert.ok(s.runs.some((x) => x.name.endsWith('-db')) ? Object.keys(s.volumes ?? {}).length === 0 : true, 'the drill database volume (restored data) is removed with its container');
  assert.deepEqual(readdirSync(w.tmp), [], 'no decrypted file is left behind');
}

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
  assert.match(r.out, /OK  drill of auth-service \d{8}T\d{6}Z passed: 10 checks; drill containers and their volumes removed; plaintext removed/);
  assert.ok(Object.values(s.volumes).length === 0 && s.calls.some((a) => a[0] === 'rm' && a.includes('-v')), 'cleanup is `docker rm -f -v`');
  assertDrillGone(w);
  // TG-2: Auth's application-level check reads the hierarchy marker through the service's own CLI; no user row is read
  assert.match(r.out, /PASS  application read: the service reads its hierarchy authority marker \(local\), equal to the backup source/);
  assert.ok(s.calls.some((a) => a[0] === 'exec' && a[1] === 'nawara-drill-auth-service-test-app' && a.includes('hierarchy-status')));
  assert.ok(!(s.queries ?? []).some((q) => q.sql.includes('"user"')), 'no user row is queried');
  assert.doesNotMatch(r.out, /Synthetic Operator Name|contentDigest|frozen_by/, 'only the mode is used; the rest of the status is never printed');
  noLeak(w, r.out);
});

test('restore drill: organization-service: the deploy\'s privilege assertion and the API known-id read', () => {
  const w = recoveryWorld(backedUp('organization-service'));
  const r = w.run({ SERVICE: 'organization-service', IMAGE: IMAGE.replace('auth', 'organization') });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS  the deploy's privilege assertion/);
  assert.match(r.out, /PASS  application read: GET \/organization\/companies\/<KNOWN_ID> returns the restored row/);
  assertDrillGone(w);
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
  ['a known id that is not a UUID (organization-service)', { SERVICE: 'organization-service', KNOWN_ID: "x'; DROP TABLE company; --" }, {}, /KNOWN_ID must be a lowercase UUID/],
  ['organization-service without a known id', { SERVICE: 'organization-service', KNOWN_ID: '' }, {}, /KNOWN_ID is required for organization-service/],
  ['a known id for auth-service (its check never reads a user)', { KNOWN_ID: KNOWN }, {}, /KNOWN_ID is not used for auth-service/],
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
  ['the service never answers ready', { notReady: true }, /GET \/ready did not answer ready/],
]) {
  test(`restore drill: fail closed when ${label}; the drill is removed and no plaintext is left`, () => {
    const w = recoveryWorld(backedUp(), { drill });
    const r = w.run();
    assert.equal(r.code, 1, r.out); assert.match(r.out, reason);
    assertDrillGone(w);
  });
}

test('restore drill: a later release restores an older backup: its extra migration applies on top of the restored history', () => {
  const w = recoveryWorld(backedUp(), { drill: { migrateOutput: 'migrations: 1 applied, 8 already applied, 0 checksum(s) recorded', historyLength: 9, facts: `${'table|company|1\ntable|schema_migrations|8\n'}structure|constraints|41\nmigrations|9|ffff\nowner|company|x\nacl|company|x=r/x\nauthority|local\ntable|later_table|0\n` } });
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /8 already applied \(history restored\), 1 later migration\(s\) applied/);
});

test('restore drill: a restored history shorter than the backup\'s is refused', () => {
  const w = recoveryWorld(backedUp(), { drill: { migrateOutput: 'migrations: 1 applied, 7 already applied, 0 checksum(s) recorded', historyLength: 7 } });
  const r = w.run();
  assert.equal(r.code, 1); assert.match(r.out, /the restored migration history is shorter than the backup's/);
});

// The migration step: the runner's exit status decides first; only then its summary, against each runner's exact contract.
const ORG_DRILL = { SERVICE: 'organization-service', IMAGE: IMAGE.replace('auth', 'organization') };
for (const [label, migrateOutput, pass] of [
  ['the current auth-service summary', 'migrations: 0 applied, 42 already applied, 0 checksum(s) recorded', /PASS  migration runner: 42 already applied \(history restored\), 0 later migration\(s\) applied, 0 checksum\(s\) recorded/],
  ['migrations applied after the backup', 'migrations: 2 applied, 42 already applied, 0 checksum(s) recorded', /PASS  migration runner: 42 already applied \(history restored\), 2 later migration\(s\) applied, 0 checksum\(s\) recorded/],
  ['legacy checksums adopted (adoptLegacyChecksums)', 'migrations: 0 applied, 42 already applied, 3 checksum(s) recorded', /PASS  migration runner: 42 already applied \(history restored\), 0 later migration\(s\) applied, 3 checksum\(s\) recorded/],
]) {
  test(`restore drill (auth-service): the migration runner's summary is read: ${label}`, () => {
    const w = recoveryWorld(backedUp(), { drill: { migrateOutput } });
    const r = w.run();
    assert.equal(r.code, 0, r.out); assert.match(r.out, pass);
  });
}

test('restore drill (organization-service): the kit runner\'s two-count summary is its contract', () => {
  const w = recoveryWorld(backedUp('organization-service'));
  const r = w.run(ORG_DRILL);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS  migration runner: 8 already applied \(history restored\), 0 later migration\(s\) applied\n/);
});

for (const [label, service, drill] of [
  ['auth-service prints the kit\'s two-count summary', 'auth-service', { migrateOutput: 'migrations: 0 applied, 8 already applied' }],
  ['organization-service prints auth-service\'s three-count summary', 'organization-service', { migrateOutput: 'migrations: 0 applied, 8 already applied, 0 checksum(s) recorded' }],
  ['the summary has trailing text', 'auth-service', { migrateOutput: 'migrations: 0 applied, 8 already applied, 0 checksum(s) recorded, 1 skipped' }],
  ['the summary is missing', 'auth-service', { migrateOutput: '  = 0001_init.sql (already applied)' }],
  ['two summaries are printed', 'auth-service', { migrateOutput: 'migrations: 0 applied, 8 already applied, 0 checksum(s) recorded\nmigrations: 1 applied, 8 already applied, 0 checksum(s) recorded' }],
  ['a count is not a number', 'auth-service', { migrateOutput: 'migrations: x applied, 8 already applied, 0 checksum(s) recorded' }],
]) {
  test(`restore drill: the runner exits 0 but ${label}: fail closed; the drill is removed`, () => {
    const w = recoveryWorld(backedUp(service), { drill });
    const r = w.run(service === 'organization-service' ? ORG_DRILL : {});
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /the image's migration runner exited 0 without its expected summary line \(unsupported output contract\)/);
    assert.doesNotMatch(r.out, /PASS  migration runner/);
    assertDrillGone(w);
  });
}

for (const service of ['auth-service', 'organization-service']) {
  test(`restore drill (${service}): a failing migration runner fails the drill with its exit status, even after a valid-looking summary`, () => {
    const summary = service === 'auth-service' ? 'migrations: 0 applied, 8 already applied, 0 checksum(s) recorded' : 'migrations: 0 applied, 8 already applied';
    const w = recoveryWorld(backedUp(service), { drill: { migrateExit: 1, migrateOutput: summary, migrateStderr: 'migration failed: 0004_x.sql was modified after it was applied' } });
    const r = w.run(service === 'organization-service' ? ORG_DRILL : {});
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /the image's migration runner refused the restored history \(exit 1\): history: an applied migration was modified: 0004_x\.sql\n/);
    assert.doesNotMatch(r.out, /PASS  migration runner|privilege assertion|GET \/ready/, 'nothing after the migration step runs');
    assertDrillGone(w);
  });
}

// A failing runner's text is never printed: only a fixed category, plus migration file names from the runner's own templates.
const LEAK = ['s3cr3t-drill-pass', 'postgres://', 'person@example.test', 'Jane Row', 'drill-token-value', 'INSERT INTO'];
for (const [label, stderr, category] of [
  ['a later migration fails with a database error quoting a row value', 'migration failed: 0009_later.sql failed and was rolled back: duplicate key value violates unique constraint "user_email_key": (email)=(person@example.test) Jane Row', /a later migration failed and was rolled back \(database error withheld\): 0009_later\.sql$/m],
  ['the database records migrations this image does not contain', 'migration failed: the database records migrations this release does not contain (0043_newer.sql, 0044_newer.sql): it was migrated by a newer or a different release; refusing to continue', /history: the database records migrations this image does not contain \(a newer or different release\): 0043_newer\.sql 0044_newer\.sql$/m],
  ['pending migrations sort before applied ones', 'migration failed: pending migrations sort before already-applied ones (0003_a.sql): the history cannot be ordered; refusing to continue', /history: pending migrations sort before applied ones: 0003_a\.sql$/m],
  ['the login is refused (the error names a connection string)', 'migration failed: password authentication failed for user "auth" at postgres://auth:s3cr3t-drill-pass@127.0.0.1:5432/auth', /database: connection or login refused \(details withheld\)$/m],
  ['an arbitrary database error quoting SQL and values', `migration failed: invalid input syntax for type uuid: "drill-token-value" in INSERT INTO "user" VALUES ('Jane Row', 'person@example.test')`, /unclassified \(details withheld\)$/m],
  ['a known template with a value where a file name belongs', "migration failed: the database records migrations this release does not contain (0043_newer.sql, Jane Row person@example.test): it was migrated by a newer or a different release; refusing to continue", /unclassified \(details withheld\)$/m],
  ['a file name template wrapped around a value', 'migration failed: person@example.test was modified after it was applied', /unclassified \(details withheld\)$/m],
]) {
  test(`restore drill: a failing runner is reported by category only, never its text: ${label}`, () => {
    const w = recoveryWorld(backedUp(), { drill: { migrateExit: 1, migrateOutput: '  = 0001_init.sql (already applied)', migrateStderr: stderr } });
    const r = w.run();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /the image's migration runner refused the restored history \(exit 1\): /); assert.match(r.out, category);
    for (const x of LEAK) assert.ok(!r.out.includes(x), `the drill output must not contain ${x}`);
    assert.ok(!r.out.includes('migration failed:') && !r.out.includes('0001_init.sql'), 'no raw runner line is echoed');
    assertDrillGone(w);
  });
}

test('restore drill: a runner that fails without a reason still fails with its exit status', () => {
  const w = recoveryWorld(backedUp(), { drill: { migrateExit: 2, migrateOutput: '' } });
  const r = w.run();
  assert.equal(r.code, 1, r.out); assert.match(r.out, /refused the restored history \(exit 2\): no reason reported/);
  assertDrillGone(w);
});

for (const [label, drill, reason] of [
  ['the service reads a different hierarchy authority state than the backup source', { appMode: 'frozen' }, /the hierarchy authority state the service reads differs from the backup source/],
  ['the service cannot read its hierarchy authority state', { statusFail: true }, /could not read its hierarchy authority state/],
]) {
  test(`restore drill (auth-service): fail closed when ${label}; the drill and its volume are removed`, () => {
    const w = recoveryWorld(backedUp(), { drill });
    const r = w.run();
    assert.equal(r.code, 1, r.out); assert.match(r.out, reason);
    assert.doesNotMatch(r.out, /Synthetic Operator Name/);
    assertDrillGone(w);
  });
}

test('restore drill: KEEP_DRILL=yes (local debugging only) keeps the containers and their volume, and says how to remove them', () => {
  const w = recoveryWorld(backedUp());
  const r = w.run({ KEEP_DRILL: 'yes' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /kept WITH the restored data; remove them with: docker rm -f -v nawara-drill-auth-service-test-app nawara-drill-auth-service-test-db/);
  assert.equal(Object.keys(w.state().volumes).length, 1);
  assert.deepEqual(readdirSync(w.tmp), [], 'plaintext files are removed even when the containers are kept');
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

// ================================================================ V2 A13: audit-service (the append-only evidence store)
const AUDIT_IMAGE = `ghcr.io/nawara-solutions/nawara-core-audit-service@sha256:${'cd'.repeat(32)}`;
const AUDIT_DRILL = { SERVICE: 'audit-service', IMAGE: AUDIT_IMAGE };
const MQ_IMAGE = 'rabbitmq:3.13.7-alpine@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc';
const AUDIT_KNOWN = ['auth-service', '0b8b7c39-0000-4000-8000-000000000001', '2026-10-01T10:00:00.123Z'];
const factsOf = (w, svc) => {
  const key = keysOf(w).find((k) => k.includes(`/${svc}/`) && k.endsWith('.facts.cms'));
  const tmp = mkdtempSync(join(tmpdir(), 'nawara-a13-dec-'));
  try { return decrypt(w, key, tmp).toString(); } finally { rmSync(tmp, { recursive: true, force: true }); }
};
const sha256 = (t) => execFileSync('sha256sum', { input: t, encoding: 'utf8' }).slice(0, 64);

test('A13 backup: audit-service dumps as audit_migrator inside nawara-core-audit-db; secret files, Audit integrity facts, the shared outbox fact', () => {
  const w = backupWorld();
  const r = w.backup('audit-service');
  assert.equal(r.code, 0, r.out);
  const s = w.state();
  assert.deepEqual(s.dumps.map((d) => [d.container, d.argv]), [['nawara-core-audit-db', ['-U', 'audit_migrator', '-d', 'audit', '-Fc']]], 'the owner reads everything (audit_app cannot read the retention tables)');
  const keys = keysOf(w);
  assert.equal(keys.length, 4);
  assert.ok(keys.every((k) => k.startsWith(`${PREFIX}/audit-service/audit-service-`)));
  assert.match(puts(w).at(-1), /\.manifest$/, 'the manifest last');
  const key = keys.find((k) => k.endsWith('.config.tar.cms'));
  const tmp = mkdtempSync(join(tmpdir(), 'nawara-a13-dec-'));
  try {
    writeFileSync(join(tmp, 'c.tar'), decrypt(w, key, tmp));
    const listing = execFileSync('tar', ['-tvf', join(tmp, 'c.tar')], { encoding: 'utf8' });
    for (const f of ['db\\.env', 'roles\\.env', '\\.env']) assert.match(listing, new RegExp(`^-rw------- .* ${f}$`, 'm'));
    assert.equal(listing.trim().split('\n').length, 3, 'exactly db.env, roles.env and .env');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const facts = factsOf(w, 'audit-service');
  const [sql] = facts.split('-- nawara-backup-facts-results\n');
  assert.match(sql, /SELECT 'outbox\|' \|\| count\(\*\)/, 'the shared outbox fact is kept (the kit baseline gives Audit an outbox)');
  for (const f of ["'trigger|'", "'funcacl|'", "'defacl|'", "'nspacl|public|'", "'audit_digest|'", "'known|'"]) assert.ok(sql.includes(f), `Audit integrity fact ${f}`);
  assert.match(sql, /extract\(epoch FROM "recordedAt"\)/, 'the record digest covers the database clock');
  assert.match(sql, /date_trunc\('milliseconds', "occurredAt" AT TIME ZONE 'UTC'\), 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'/, 'the known instant is millisecond-precise (the API\'s from/to grammar; found by the A13.2 real-PostgreSQL smoke)');
  assert.doesNotMatch(sql, /hierarchy_authority|ownership_state/, 'no other service\'s authority marker');
  assert.match(status(w, 'audit-service', 'last-attempt'), /^result=succeeded$/m);
  assert.deepEqual(workLeft(w), []);
  noLeak(w, r.out + JSON.stringify(s.calls) + status(w, 'audit-service', 'last-success'));
});

test('A13 regression: the Auth and Organization facts SQL equals the certified tooling except the A13.3b canonical ACL fact (pinned hashes)', () => {
  const w = backupWorld();
  assert.equal(w.backup('auth-service organization-service').code, 0);
  const golden = {
    // origin/main 16539b5 had 723475830e5f… (auth) and ca1375eb474e… (organization); the only difference is the acl| fact (A13.3b)
    'auth-service': '8d15946631b62f313bee903e41f22ddc5baa02220eeb474461748da9c110b287',
    'organization-service': 'baa054298172754abf62a83c2a9a7b729d3c0b6d6ad11faa33ed9881e44bf70c',
  };
  for (const [svc, hash] of Object.entries(golden)) {
    const [sql] = factsOf(w, svc).split('-- nawara-backup-facts-results\n');
    assert.equal(sha256(sql), hash, `${svc}: facts SQL unchanged`);
  }
  assert.deepEqual(w.state().dumps.map((d) => d.argv), [['-U', 'auth_app', '-d', 'auth', '-Fc'], ['-U', 'organization_migrator', '-d', 'organization', '-Fc']]);
});

for (const table of ['schema_migrations', 'audit_record', 'audit_retention_policy', 'audit_retention_run', 'outbox', 'inbox']) {
  test(`A13 backup: fail closed when the archive has no data section for ${table} (REQUIRED_DATA); nothing is uploaded`, () => {
    const w = backupWorld({ backup: { tocMissing: table } });
    const r = w.backup('audit-service');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`the archive holds no data for table ${table}; nothing was uploaded`));
    assert.deepEqual(puts(w), []); assert.deepEqual(workLeft(w), []);
    assert.match(status(w, 'audit-service', 'last-attempt'), /^result=failed\nstage=verify$/m);
  });
}

test('A13 backup: kit_rate_limit (ephemeral counters) is facts-only: the backup does not require its data section', () => {
  const script = readFileSync(SCRIPTS.backup, 'utf8');
  const line = script.match(/REQUIRED_DATA="schema_migrations audit_record[^"]*"/)[0];
  assert.doesNotMatch(line, /kit_rate_limit/);
  assert.equal(backupWorld({ backup: { tocMissing: 'kit_rate_limit' } }).backup('audit-service').code, 0);
});

test('A13 backup: a missing roles.env fails audit-service at preflight; nothing is dumped for it', () => {
  const w = backupWorld();
  rmSync(join(w.home, 'nawara-core', 'audit-service', 'roles.env'));
  const r = w.backup('audit-service');
  assert.equal(r.code, 1);
  assert.match(r.out, /audit-service\/roles\.env is missing; nothing was backed up/);
  assert.equal(w.state().dumps, undefined);
});

test('A13 backup: partial failure: a missing audit database fails audit-service only; auth-service is still backed up (exit 1)', () => {
  const w = backupWorld({ dbs: ['nawara-core-auth-db'] });
  const r = w.backup('auth-service audit-service');
  assert.equal(r.code, 1);
  assert.match(r.out, /audit-service: database container nawara-core-audit-db not found/);
  assert.equal(keysOf(w).filter((k) => k.includes('/auth-service/')).length, 4);
  assert.match(status(w, 'audit-service', 'last-attempt'), /^result=failed\nstage=preflight$/m);
  assert.match(status(w, 'auth-service', 'last-attempt'), /^result=succeeded$/m);
});

test('A13 backup: the allow-list names audit-service; an unknown service is still refused before anything is dumped', () => {
  const w = backupWorld();
  const r = w.backup('billing-service');
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown service 'billing-service' \(known: organization-service auth-service audit-service\)/);
  assert.equal(w.state().dumps, undefined);
});

test('A13 retention: 35 Audit backup days keep the newest 30; Auth and Organization objects and look-alikes are never touched', () => {
  const others = { ...seeded(3, {}, 'auth-service'), ...seeded(3, {}, 'organization-service') };
  const extra = { [`${PREFIX}/audit-service-evil/audit-service-20260101T021700Z.manifest`]: 1, [`${PREFIX}/audit-service/audit-service-20260101T021700Z.manifest.bak`]: 1 };
  const w = backupWorld({ s3: { objects: { ...seeded(35, extra, 'audit-service'), ...others } } });
  const r = w.backup('audit-service');
  assert.equal(r.code, 0, r.out);
  const deleted = w.state().s3.deleted;
  assert.equal(deleted.length, 6 * 4);
  for (const k of deleted) assert.match(k, new RegExp(`^${PREFIX}/audit-service/audit-service-2026010[1-6]T021700Z\\.(db\\.dump\\.cms|config\\.tar\\.cms|facts\\.cms|manifest)$`));
  const left = keysOf(w);
  for (const k of [...Object.keys(others).map((x) => x.slice(BUCKET.length + 1)), ...Object.keys(extra)]) assert.ok(left.includes(k), `never touched: ${k}`);
});

// ---------------------------------------------------------------- A13 restore drill
test('A13 restore drill: audit-service: isolated database and disposable broker, facts before narrowing, assertion, controls, real /ready, known-record read', () => {
  const w = recoveryWorld(backedUp('audit-service'));
  const r = w.run(AUDIT_DRILL);
  assert.equal(r.code, 0, r.out);
  const s = w.state();
  const DDB = 'nawara-drill-audit-service-test-db'; const DMQ = 'nawara-drill-audit-service-test-mq'; const DAPP = 'nawara-drill-audit-service-test-app';
  const db = s.runs.find((x) => x.name === DDB); const mq = s.runs.find((x) => x.name === DMQ); const app = s.runs.find((x) => x.name === DAPP);
  assert.equal(db.network, 'none', 'the drill database has no network at all');
  assert.equal(mq.network, `container:${DDB}`, 'the broker shares only the drill namespace');
  assert.equal(mq.image, MQ_IMAGE, 'the production broker\'s pinned image, nothing else of production');
  assert.ok(mq.env.includes('RABBITMQ_NODENAME=rabbit@localhost') && mq.env.includes('RABBITMQ_DEFAULT_VHOST=nawara-core') && mq.env.includes('RABBITMQ_DEFAULT_USER=drill'));
  assert.equal(app.network, `container:${DDB}`);
  assert.equal(app.image, AUDIT_IMAGE);
  const url = app.env.filter((e) => e.startsWith('RABBITMQ_URL='));
  assert.equal(url.length, 1); assert.match(url[0], /^RABBITMQ_URL=amqp:\/\/drill:[0-9a-f]{48}@127\.0\.0\.1:5672\/nawara-core$/, 'the disposable broker only');
  assert.ok(!app.env.some((e) => e.includes('nawara-core-rabbitmq') || e.includes(SECRETS.broker) || e.includes(SECRETS.auditApp)), 'no production endpoint or credential');
  assert.ok(app.env.some((e) => /^SERVICE_TOKENS=drill-reader:[0-9a-f]{64}$/.test(e)), 'a drill-only read credential');
  assert.ok(app.env.includes('AUDIT_SERVICE_POLICY={"callers":{"drill-reader":{"operations":["read_platform"],"categories":["security","business","commercial","administrative"]}}}'));
  assert.ok(!s.calls.some((a) => a[0] === 'exec' && a.includes(DMQ) && !a.includes('rabbitmq')), 'the broker CLI always runs as the rabbitmq user');
  assert.notEqual(s.rootCli, true);
  // order: roles -> restore -> migrations -> facts (source state) -> narrowing -> assertion -> controls -> broker -> service -> consumer -> read
  const at = (pred) => s.calls.findIndex(pred);
  const stdinAt = (needle) => s.stdin.find((x) => x.container === DDB && x.text.includes(needle))?.at;
  const roles = stdinAt('CREATE ROLE audit_migrator'); const restore = s.restores[0].at;
  const migrate = at((a) => a[0] === 'run' && a.includes('--rm') && a.includes('../../libs/service-kit/dist/cli/migrate.js'));
  const facts = s.stdin.filter((x) => x.container === DDB && x.text.includes('-- nawara-backup-facts')).map((x) => x.at)[0];
  const narrow = stdinAt('REVOKE ALL ON TABLE schema_migrations FROM audit_app;');
  const forbiddenQ = s.queries.find((q) => q.container === DDB && q.sql.includes('WHERE has_table_privilege')).at;
  const controls = stdinAt('-- nawara-drill-controls');
  const mqRun = at((a) => a[0] === 'run' && a.includes(DMQ)); const appRun = at((a) => a[0] === 'run' && a.includes(DAPP));
  const consumers = at((a) => a[0] === 'exec' && a.includes('list_consumers'));
  assert.ok(roles < restore && restore < migrate && migrate < facts && facts < narrow && narrow < forbiddenQ && forbiddenQ < controls
    && controls < mqRun && mqRun < appRun && appRun < consumers, 'the frozen A13.1 order');
  const ctl = s.stdin.find((x) => x.text.includes('-- nawara-drill-controls')).text;
  for (const n of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9a', 'N9b', 'N9c', 'N10']) assert.ok(ctl.includes(`refused('${n}'`), `control ${n}`);
  assert.match(ctl, /SET LOCAL ROLE audit_app;[\s\S]*"recordedAt"[\s\S]*2000-01-01T00:00:00Z[\s\S]*ERRCODE = 'NWRA1'/, 'P1 is inside a rolled-back block');
  assert.deepEqual(s.auditReads[0].args, [AUDIT_KNOWN[2], AUDIT_KNOWN[0], AUDIT_KNOWN[1]], 'the newest record recorded at backup time is read back (instant, source, eventId)');
  for (const p of [/PASS  disposable drill broker ready in the drill namespace/, /PASS  the deploy's privilege assertion/, /PASS  append-only and privilege controls: 12 refusals/,
    /PASS  GET \/ready -> \{"status":"ready"\} \(the real contract: the restored database, its migrations, the drill broker and the ingestion consumer\)/,
    /PASS  the ingestion consumer is attached to the disposable drill broker/, /PASS  application read: GET \/audit\/platform\/records returns the newest record/,
    /PASS  \d+ restore facts equal the backup's \(row counts, structure, migration history, owners, ACLs, append-only triggers/,
    /DRILL_RESULT service=audit-service stamp=\d{8}T\d{6}Z checks=\d+ duration_s=\d+$/m]) assert.match(r.out, p);
  assert.doesNotMatch(r.out, /NOTICE/, 'a narrowed source raises no O3-B notice');
  assertDrillGone(w);
  noLeak(w, r.out);
});

test('A13 restore drill: a backup source still at O3-B is reported (NOTICE), and the intended state is applied and asserted', () => {
  const w = recoveryWorld(backedUp('audit-service'), { drill: { sourceWrites: 'INSERT,UPDATE,DELETE' } });
  const r = w.run(AUDIT_DRILL);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /NOTICE {2}backup source: audit_app could INSERT,UPDATE,DELETE schema_migrations \(O3-B present at the source\)/);
  assert.match(r.out, /PASS  audit_app: LOGIN NOSUPERUSER .* runtime SELECT only/);
});

for (const [label, drill, reason] of [
  ['a control is not refused (N2: the append-only trigger)', { controlFail: 'N2' }, /an append-only or privilege control was not refused as expected \(nawara-control N2\)/],
  ['the database clock does not stamp recordedAt (P1)', { controlFail: 'P1' }, /\(nawara-control P1\)/],
  ['an append-only trigger is missing or disabled (P2)', { triggersEnabled: 5 }, /append-only and immutability triggers are not all present and enabled after the restore \(P2\)/],
  ['the disposable broker never becomes ready', { mqNeverReady: true }, /the disposable drill broker did not become ready/],
  ['the broker is not confined to the drill namespace', { networkModeOf: { 'nawara-drill-audit-service-test-mq': 'bridge' } }, /the drill broker is not confined to the drill namespace/],
  ['the service is not confined to the drill namespace', { networkModeOf: { 'nawara-drill-audit-service-test-app': 'nawara-core-internal' } }, /the drill service is not confined to the drill namespace/],
  ['the service never answers ready (real /ready)', { notReady: true }, /GET \/ready did not answer ready/],
  ['the ingestion consumer is not on the drill broker', { consumers: '' }, /the ingestion consumer is not attached to the disposable drill broker/],
  ['the known record read through the API does not match', { auditRead: 'mismatch' }, /the known record read through the API does not match the record recorded at backup time \(mismatch\)/],
  ['the drill reader is refused', { auditRead: 'status=403' }, /does not match the record recorded at backup time \(status=403\)/],
  ['a restored fact differs from the backup', { facts: 'table|company|1\n' }, /a restored fact differs from the backup/],
]) {
  test(`A13 restore drill: fail closed when ${label}; every drill container and its volume is removed`, () => {
    const w = recoveryWorld(backedUp('audit-service'), { drill });
    const r = w.run(AUDIT_DRILL);
    assert.equal(r.code, 1, r.out); assert.match(r.out, reason);
    assert.doesNotMatch(r.out, /secret-row-value|CONTEXT:/, 'a failing control prints its name, never its statement or a value');
    assertDrillGone(w);
    noLeak(w, r.out);
  });
}

test('A13 restore drill: the deploy\'s privilege assertion applies after the restore (audit_app able to write the history fails the drill)', () => {
  const w = recoveryWorld(backedUp('audit-service'));
  w.patch((s) => { s.audit = { forbidden: 'schema_migrations:INSERT' }; });
  const r = w.run(AUDIT_DRILL);
  assert.equal(r.code, 1); assert.match(r.out, /audit_app holds forbidden privileges after the restore \(schema_migrations:INSERT\)/);
  assertDrillGone(w);
});

test('A13 restore drill: a backup with no audit record to read back (known|none) is refused before any control or service', () => {
  const b = backupWorld({ backup: { facts: 'table|audit_record|0\nmigrations|6|0123456789abcdef0123456789abcdef\nknown|none\n' } });
  assert.equal(b.backup('audit-service').code, 0);
  const w = recoveryWorld(b, { drill: { facts: 'table|audit_record|0\nmigrations|6|0123456789abcdef0123456789abcdef\nknown|none\n' } });
  const r = w.run(AUDIT_DRILL);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /the backup recorded no audit record to read back/);
  assert.ok(!w.state().stdin.some((x) => x.text.includes('-- nawara-drill-controls')), 'no control ran');
  assertDrillGone(w);
});

for (const [label, env, containers, reason] of [
  ['a Docker host running the production audit database', {}, { 'nawara-core-audit-db': DB_CONTAINER('nawara-core-audit-db') }, /runs nawara-core-audit-db: a drill belongs in the recovery environment/],
  ['an existing drill broker', {}, { 'nawara-drill-audit-service-test-mq': DB_CONTAINER('x') }, /nawara-drill-audit-service-test-mq already exists/],
  ['a known id for audit-service (its record comes from the backup)', { KNOWN_ID: KNOWN }, {}, /KNOWN_ID is not used for audit-service/],
]) {
  test(`A13 restore drill: refused before anything is created: ${label}`, () => {
    const w = recoveryWorld(backedUp('audit-service'), { containers });
    const r = w.run({ ...AUDIT_DRILL, ...env });
    assert.equal(r.code, 1, r.out); assert.match(r.out, reason);
    assert.equal((w.state().runs ?? []).length, 0, 'no container was created');
  });
}

test('A13 restore drill: KEEP_DRILL=yes keeps the database, the broker and the service, and says how to remove all three', () => {
  const w = recoveryWorld(backedUp('audit-service'));
  const r = w.run({ ...AUDIT_DRILL, KEEP_DRILL: 'yes' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /remove them with: docker rm -f -v nawara-drill-audit-service-test-app nawara-drill-audit-service-test-mq nawara-drill-audit-service-test-db/);
  assert.equal(Object.keys(w.state().containers).filter((n) => n.startsWith('nawara-drill-')).length, 3);
  assert.deepEqual(readdirSync(w.tmp), [], 'plaintext files are removed even when the containers are kept');
});

// ---------------------------------------------------------------- A13.3b: the canonical ACL fact and the TCP readiness probe
test('A13.3b: the acl| fact is canonical: a NULL (default) ACL is written out with acldefault() of the right object type; real ACLs as stored', () => {
  const w = backupWorld();
  assert.equal(w.backup('auth-service organization-service audit-service').code, 0);
  for (const svc of ['auth-service', 'organization-service', 'audit-service']) {
    const [sql] = factsOf(w, svc).split('-- nawara-backup-facts-results\n');
    const line = sql.split('\n').find((l) => l.startsWith("SELECT 'acl|'"));
    assert.equal(line, `SELECT 'acl|' || c.relname || '|' || array_to_string(coalesce(c.relacl, acldefault(CASE c.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner)), ' ')`,
      `${svc}: stored ACL when present, else the default ACL of the object's own type (sequence 's', table 'r')`);
    assert.match(sql, /c\.relkind IN \('r', 'S'\)/, 'tables and sequences only, as before');
    assert.doesNotMatch(sql, /coalesce\(array_to_string\(c\.relacl, ' '\), ''\)/, 'the raw form (NULL written as empty) is gone');
  }
});

test('A13.3b: the drill waits for PostgreSQL over TCP loopback; the socket-only init server is not accepted (fail closed)', () => {
  const ok = recoveryWorld(backedUp());
  assert.equal(ok.run().code, 0);
  const probes = ok.state().readinessProbes;
  assert.ok(probes.length > 0 && probes.every((a) => a[0] === '-h' && a[1] === '127.0.0.1' && a.includes('-U') && a.includes('-d') && a.includes('-q')), 'every probe is pg_isready -h 127.0.0.1 -U <user> -d <db> -q');
  const init = recoveryWorld(backedUp(), { drill: { initServerOnly: true } });
  const r = init.run();
  assert.equal(r.code, 1, r.out); assert.match(r.out, /the drill database did not start/);
  assert.equal(init.state().restores, undefined, 'nothing is restored into a database that is not the final server');
  assertDrillGone(init);
});

test('A13.3b: a drill database that never becomes ready fails closed (no restore; the drill is removed)', () => {
  const w = recoveryWorld(backedUp('audit-service'), { drill: { dbNeverReady: true } });
  const r = w.run(AUDIT_DRILL);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /the drill database did not start/);
  assert.equal(w.state().restores, undefined);
  assertDrillGone(w);
});

// ---------------------------------------------------------------- A13.4a (M1): an Audit backup requires migration 0004 at the source
const REQUIRED_AUDIT_MIGRATION = '0004_changes_validation_search_path.sql';

test('A13.4a: audit-service checks that 0004 is applied, as audit_migrator, before anything is dumped; then backs up normally', () => {
  const w = backupWorld();
  const r = w.backup('audit-service');
  assert.equal(r.code, 0, r.out);
  const s = w.state();
  assert.equal(s.migrationChecks.length, 1);
  const check = s.migrationChecks[0];
  assert.equal(check.container, 'nawara-core-audit-db');
  assert.equal(check.sql, `SELECT count(*) FROM schema_migrations WHERE name = '${REQUIRED_AUDIT_MIGRATION}'`, 'the exact migration, a constant of the target');
  const argv = s.calls[check.at];
  assert.deepEqual(argv.slice(argv.indexOf('-U'), argv.indexOf('-U') + 4), ['-U', 'audit_migrator', '-d', 'audit']);
  const dumpAt = s.calls.findIndex((a) => a[0] === 'exec' && a.includes('pg_dump') && !a.includes('--version'));
  assert.ok(check.at < dumpAt, 'the prerequisite is checked before pg_dump');
  assert.equal(keysOf(w).length, 4);
  assert.match(status(w, 'audit-service', 'last-attempt'), /^result=succeeded$/m);
});

for (const [label, backup, reason] of [
  ['0004 is not applied', { missingMigration: true }, new RegExp(`required migration ${REQUIRED_AUDIT_MIGRATION.replace(/\./g, '\\.')} is not applied in audit \\(deploy it first\\); nothing was backed up`)],
  ['the migration history cannot be read', { historyUnreadable: true }, /the migration history of audit could not be read; nothing was backed up/],
]) {
  test(`A13.4a: fail closed when ${label}: no dump, no encryption, no upload, no manifest, no success status (preflight)`, () => {
    const w = backupWorld({ backup });
    const r = w.backup('audit-service');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, reason);
    const s = w.state();
    assert.equal(s.dumps, undefined, 'pg_dump never ran');
    assert.equal(s.s3.calls.length, 0, 'nothing reached the bucket (no object, no manifest)');
    assert.deepEqual(workLeft(w), [], 'no work directory, so nothing was encrypted');
    assert.match(status(w, 'audit-service', 'last-attempt'), /^result=failed\nstage=preflight$/m);
    assert.equal(existsSync(join(w.bk, 'status', 'audit-service.last-success')), false, 'no success status');
    noLeak(w, r.out);
  });
}

test('A13.4a: Auth and Organization run no migration prerequisite; a refused Audit backup does not stop them (exit 1)', () => {
  const w = backupWorld({ backup: { missingMigration: true } });
  const r = w.backup('auth-service organization-service audit-service');
  assert.equal(r.code, 1, r.out);
  const s = w.state();
  assert.deepEqual(s.migrationChecks.map((c) => c.container), ['nawara-core-audit-db'], 'only audit-service is checked');
  assert.deepEqual(s.dumps.map((d) => d.container), ['nawara-core-auth-db', 'nawara-core-organization-db'], 'Auth and Organization are dumped as before');
  for (const svc of ['auth-service', 'organization-service']) assert.equal(keysOf(w).filter((k) => k.includes(`/${svc}/`)).length, 4);
  assert.equal(keysOf(w).filter((k) => k.includes('/audit-service/')).length, 0);
});

test('A13.4a: the prerequisite cannot be bypassed or redirected: a caller REQUIRED_MIGRATION is ignored; look-alike service names are refused', () => {
  const w = backupWorld();
  assert.equal(w.backup('audit-service', { REQUIRED_MIGRATION: '0001_audit_record.sql' }).code, 0);
  assert.equal(w.state().migrationChecks[0].sql, `SELECT count(*) FROM schema_migrations WHERE name = '${REQUIRED_AUDIT_MIGRATION}'`);
  const a = backupWorld();
  assert.equal(a.backup('auth-service', { REQUIRED_MIGRATION: '0001_audit_record.sql' }).code, 0);
  assert.equal(a.state().migrationChecks, undefined, 'a caller value never makes Auth run a check');
  for (const svc of ['audit-service;true', 'Audit-Service', 'audit', "audit-service'"]) {
    const x = backupWorld();
    const r = x.backup(svc);
    assert.equal(r.code, 1); assert.match(r.out, /unknown service/);
    assert.equal(x.state().dumps, undefined); assert.equal(x.state().migrationChecks, undefined);
  }
});

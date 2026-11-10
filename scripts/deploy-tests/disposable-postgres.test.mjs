// The real-broker harnesses' disposable PostgreSQL (lib/disposable-postgres.mjs), against the fake `docker` (lib/fake-docker-cli.mjs), which
// models Docker's rule: the postgres image's VOLUME becomes an ANONYMOUS volume (64-hex name, `com.docker.volume.anonymous` label) that only
// `docker rm -v` removes with its container; named volumes are never removed by `rm -v`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, world } from './lib/harness.mjs';
import { PG_DATA, anonymousDataVolume, removeWithAnonymousVolume } from './lib/disposable-postgres.mjs';
import { cleanupAll } from './lib/owned-process.mjs';

const BROKER_VOLUME = 'rbcons-1-data';
const SHARED_NAMED = 'nawara-core_nawara_pgdata';

/**
 * A run's resources as the harness creates them (the broker on its NAMED volume, then PostgreSQL with no mount for its data directory),
 * next to resources that are not the run's: another PostgreSQL with its own anonymous volume, and a named volume of a Compose project.
 */
function scene() {
  const w = world();
  w.patch((s) => { s.volumes = { [BROKER_VOLUME]: { labels: {} }, [SHARED_NAMED]: { labels: { 'com.docker.compose.project': 'nawara-core' } } }; });
  const env = { ...process.env, PATH: `${join(w.dir, 'bin')}:${process.env.PATH}`, FAKE_DOCKER_STATE: join(w.dir, 'state.json') };
  const docker = (...args) => spawnSync('docker', args, { env, encoding: 'utf8' });
  const idOf = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const other = idOf(docker('run', '-d', '--name', 'nawara-s0c15b-pg', '-e', 'POSTGRES_PASSWORD=x', 'postgres:16.15'));
  const broker = idOf(docker('run', '-d', '--name', 'rbcons-1-rabbitmq', '-v', `${BROKER_VOLUME}:/var/lib/rabbitmq`, 'rabbitmq:3.13.7-alpine'));
  const pg = idOf(docker('run', '-d', '--name', 'rbcons-1-pg', '-e', 'POSTGRES_PASSWORD=x', '-p', '127.0.0.1::5432', 'postgres:16-alpine'));
  const anonOf = (name) => Object.entries(w.state().volumes).filter(([, v]) => v.anonymousOf === name).map(([k]) => k);
  return { w, env, docker, other, broker, pg, anonOf, before: Object.keys(w.state().volumes).sort() };
}

test('the anonymous data volume is identified exactly: the ONE 64-hex, anonymous-labelled volume at the data directory of THIS container', () => {
  const s = scene();
  const [own] = s.anonOf('rbcons-1-pg');
  assert.match(own, /^[0-9a-f]{64}$/);
  assert.equal(anonymousDataVolume(s.pg, { env: s.env }), own, 'its own volume, by container id');
  assert.notEqual(anonymousDataVolume(s.other, { env: s.env }), own, 'another PostgreSQL has a different one');
});

test('normal teardown: `rm -f -v` of the harness container removes it and its anonymous volume, and nothing else', () => {
  const s = scene();
  const volume = anonymousDataVolume(s.pg, { env: s.env });
  const callsBefore = s.w.state().calls.length;
  removeWithAnonymousVolume(s.pg, volume, { env: s.env });
  const st = s.w.state();
  const issued = st.calls.slice(callsBefore);
  assert.deepEqual(issued.filter((a) => a[0] === 'rm'), [['rm', '-f', '-v', s.pg]], 'exactly one removal, of the recorded container id');
  assert.ok(!issued.some((a) => (a[0] === 'volume' && a[1] !== 'inspect') || a.includes('prune')), 'no volume removal by name, no prune');
  assert.ok(!st.containers['rbcons-1-pg'], 'the PostgreSQL container is gone');
  assert.ok(!st.volumes[volume], 'its anonymous volume is gone');
  assert.deepEqual(Object.keys(st.volumes).sort(), s.before.filter((v) => v !== volume), 'every other volume is untouched');
  assert.ok(st.containers['rbcons-1-rabbitmq'] && st.containers['nawara-s0c15b-pg'], 'the broker and the unrelated container are untouched');
  assert.deepEqual(s.anonOf('nawara-s0c15b-pg').length, 1, "the unrelated container keeps its own anonymous volume");
});

test('the named broker volume keeps its lifecycle: `rm -v` never removes it; only the explicit `volume rm` after the container does', () => {
  const s = scene();
  // even the PostgreSQL removal with -v leaves it, and so would `rm -f -v` of the broker itself (Docker removes only ANONYMOUS volumes)
  removeWithAnonymousVolume(s.pg, anonymousDataVolume(s.pg, { env: s.env }), { env: s.env });
  assert.ok(s.w.state().volumes[BROKER_VOLUME], 'untouched by the PostgreSQL removal');
  assert.notEqual(s.docker('volume', 'rm', BROKER_VOLUME).status, 0, 'still in use by the broker: Docker refuses to remove it');
  assert.equal(s.docker('rm', '-f', s.broker).status, 0, 'the harness removes the broker as before (`rm -f`, unchanged)');
  assert.ok(s.w.state().volumes[BROKER_VOLUME], 'removing the broker container leaves its named volume');
  assert.equal(s.docker('volume', 'rm', BROKER_VOLUME).status, 0, 'then the harness removes it by its recorded name, as before');
  assert.ok(s.w.state().volumes[SHARED_NAMED], 'the Compose project volume is never touched');
});

test('NEGATIVE CONTROL (the original leak): `rm -f` without -v removes the container but leaves its anonymous volume behind', () => {
  const s = scene();
  const volume = anonymousDataVolume(s.pg, { env: s.env });
  assert.equal(s.docker('rm', '-f', s.pg).status, 0);
  assert.ok(!s.w.state().containers['rbcons-1-pg']);
  assert.ok(s.w.state().volumes[volume], 'the fake reproduces the orphan the old harness teardown left');
  assert.equal(s.docker('volume', 'inspect', volume).status, 0, 'and the existence check the helper runs after removal would see it');
});

test('a failure elsewhere in the cleanup does not stop the PostgreSQL removal, and is still reported', async () => {
  const s = scene();
  const volume = anonymousDataVolume(s.pg, { env: s.env });
  await assert.rejects(cleanupAll([
    ['stop the Notification child', async () => { throw new Error('boom'); }],
    ['remove container with its anonymous data volume', async () => removeWithAnonymousVolume(s.pg, volume, { env: s.env })],
  ]), (e) => /stop the Notification child: boom/.test(e.message) && !/anonymous data volume:/.test(e.message));
  assert.ok(!s.w.state().containers['rbcons-1-pg'] && !s.w.state().volumes[volume], 'removed although an earlier step failed');
});

test('a failed container removal is reported, never taken for a clean removal; the container and its volume stay for inspection', async () => {
  const s = scene();
  const volume = anonymousDataVolume(s.pg, { env: s.env });
  s.w.patch((st) => { st.failContainerRm = { 'rbcons-1-pg': true }; });
  assert.throws(() => removeWithAnonymousVolume(s.pg, volume, { env: s.env }), /docker rm -f -v .* failed: .*simulated failure/);
  await assert.rejects(cleanupAll([['remove container with its anonymous data volume', async () => removeWithAnonymousVolume(s.pg, volume, { env: s.env })]]),
    /cleanup: remove container with its anonymous data volume: docker rm -f -v/);
  assert.ok(s.w.state().containers['rbcons-1-pg'] && s.w.state().volumes[volume]);
});

test('a volume that survives the removal is reported (the removal cannot be proven), not ignored', () => {
  const s = scene();
  const volume = anonymousDataVolume(s.pg, { env: s.env });
  s.w.patch((st) => { st.volumes[volume].anonymousOf = 'someone-else'; }); // Docker would not remove it with this container
  assert.throws(() => removeWithAnonymousVolume(s.pg, volume, { env: s.env }), new RegExp(`anonymous volume ${volume} still exists`));
});

test('a teardown without a recorded identity still removes with -v, but reports that it cannot prove the volume is gone', () => {
  const s = scene();
  const [own] = s.anonOf('rbcons-1-pg');
  assert.throws(() => removeWithAnonymousVolume(s.pg, undefined, { env: s.env }), /never identified: cannot prove it is gone/);
  assert.ok(!s.w.state().containers['rbcons-1-pg'] && !s.w.state().volumes[own], '-v still removed it');
});

test('a missing or unexpected volume identity fails closed, with an explicit reason', () => {
  const s = scene();
  const fails = (ref, re) => assert.throws(() => anonymousDataVolume(ref, { env: s.env }), re);
  fails('no-such-container', /cannot inspect the PostgreSQL container/);
  fails(s.broker, new RegExp(`expected exactly one mount at ${PG_DATA}.*found 0`));
  // a NAMED volume at the data directory is not the harness's to remove
  const named = s.docker('run', '-d', '--name', 'x-named-pg', '-v', `${SHARED_NAMED}:${PG_DATA}`, 'postgres:16-alpine').stdout.trim();
  fails(named, /is not an anonymous volume .*refusing to own it/);
  // a bind mount there
  const bind = s.docker('run', '-d', '--name', 'x-bind-pg', '-v', `/tmp/pgdata:${PG_DATA}`, 'postgres:16-alpine').stdout.trim();
  fails(bind, /is not an anonymous volume \(type bind/);
  // two mounts at the data directory: ambiguous
  s.w.patch((st) => { st.extraMountsOf = { 'rbcons-1-pg': [{ Type: 'volume', Name: 'f'.repeat(64), Destination: PG_DATA, RW: true }] }; });
  fails(s.pg, /found 2/);
  s.w.patch((st) => { delete st.extraMountsOf; });
  // a 64-hex volume Docker does not label anonymous
  const [own] = s.anonOf('rbcons-1-pg');
  s.w.patch((st) => { st.volumes[own].labels = {}; });
  fails(s.pg, /is not labelled com\.docker\.volume\.anonymous: refusing to own it/);
  s.w.patch((st) => { st.volumes[own].labels = null; });
  fails(s.pg, /is not labelled/);
});

test('both harnesses wire it: identify right after creating PostgreSQL, remove it ONLY through the helper (never a bare `rm -f`)', () => {
  for (const f of ['real-broker-consumers.mjs', 'real-broker-notification-topology.mjs']) {
    const text = readFileSync(join(ROOT, 'scripts/deploy-tests', f), 'utf8');
    const run = text.indexOf("created.pg = docker('run', '-d', '--name', PG,");
    assert.ok(run > 0, `${f}: the PostgreSQL id is recorded as created.pg`);
    assert.ok(text.indexOf('created.pgDataVolume = anonymousDataVolume(created.pg)', run) > run, `${f}: its volume is identified after creation`);
    assert.match(text, /id === created\.pg[\s\S]{0,200}removeWithAnonymousVolume\(id, created\.pgDataVolume\)/, `${f}: the PostgreSQL removal goes through the helper`);
    assert.equal((text.match(/postgres:16-alpine/g) ?? []).length, 1, `${f}: one PostgreSQL container`);
  }
});

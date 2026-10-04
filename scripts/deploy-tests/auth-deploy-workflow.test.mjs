// V2-A.2: executes the REAL shell steps of .github/workflows/auth-service-deploy.yml (digest validation and artifact verification)
// against a fake docker CLI and a throwaway git history, so a loosened regex or a dropped revision/ancestry check fails here, not in
// production. Nothing here touches a registry, a server or the real repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ROOT } from './lib/harness.mjs';

const workflow = parse(readFileSync(join(ROOT, '.github/workflows/auth-service-deploy.yml'), 'utf8'));
// V2-A.3 (A3.5): validation and artifact verification run in the `verify` job, before the production approval.
const steps = workflow.jobs.verify.steps;
const stepRun = (name) => {
  const step = steps.find((s) => s.name === name);
  assert.ok(step?.run, `step "${name}" not found in auth-service-deploy.yml`);
  return step.run;
};
const VALIDATE = stepRun('validate the digest');
const VERIFY = stepRun('verify the artifact');
const IMAGE_NAME = 'ghcr.io/nawara-solutions/nawara-core-auth-service';
const digest = (seed) => `sha256:${seed.repeat(64).slice(0, 64)}`;

function bash(script, env, cwd = tmpdir()) {
  const r = spawnSync('bash', ['-c', script], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('the deploy job re-checks the digest with the very same validation before its SSH step', () => {
  const recheck = workflow.jobs.deploy.steps.find((s) => s.name === 'validate the digest');
  assert.equal(recheck?.run, VALIDATE);
});

test('digest validation accepts exactly sha256:<64 lowercase hex>', () => {
  assert.equal(bash(VALIDATE, { DIGEST: digest('0a') }).code, 0);
});

test('digest validation refuses every malformed or hostile value, and never evaluates it', () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'v2a2-')), 'pwned');
  const bad = [
    '', 'sha256:', `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`, `sha256:${'A'.repeat(64)}`, `sha512:${'a'.repeat(64)}`,
    `${'a'.repeat(64)}`, 'production', ':production', `${IMAGE_NAME}@${digest('0a')}`, `${digest('0a')}\n`, ` ${digest('0a')}`,
    `sha256:$(touch ${marker})${'a'.repeat(40)}`, `${digest('0a')}; touch ${marker}`,
  ];
  for (const value of bad) assert.notEqual(bash(VALIDATE, { DIGEST: value }).code, 0, `accepted: ${JSON.stringify(value)}`);
  assert.equal(existsSync(marker), false, 'an input was evaluated by the shell');
});

/** A git history with one main commit (an ancestor of HEAD) and one side commit (e.g. a PR merge ref) that is not. */
function history() {
  const dir = mkdtempSync(join(tmpdir(), 'v2a2-git-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'earlier main');
  const earlier = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  git('commit', '-q', '--allow-empty', '-m', 'pull request build');
  const side = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'current main');
  return { dir, earlier, side, head: git('rev-parse', 'HEAD') };
}

/** A fake `docker` that knows a set of digests in the auth-service repository and answers `buildx imagetools inspect`. */
function fakeDocker(images) {
  const bin = mkdtempSync(join(tmpdir(), 'v2a2-bin-'));
  writeFileSync(join(bin, 'images.json'), JSON.stringify(images));
  const script = `#!/usr/bin/env node
const images = require(${JSON.stringify(join(bin, 'images.json'))});
const a = process.argv.slice(2);
if (a[0] !== 'buildx' || a[1] !== 'imagetools' || a[2] !== 'inspect') { console.error('unexpected docker call: ' + a.join(' ')); process.exit(2); }
const ref = a[3];
const image = ref.startsWith(${JSON.stringify(`${IMAGE_NAME}@`)}) ? images[ref.split('@')[1]] : undefined;
if (!image) { console.error('ERROR: ' + ref + ': not found'); process.exit(1); }
if (a[4] === '--format') { if (a[5] !== '{{json .Image}}') process.exit(3); process.stdout.write(JSON.stringify(image)); }
`;
  writeFileSync(join(bin, 'docker'), script);
  chmodSync(join(bin, 'docker'), 0o755);
  return bin;
}

const labelled = (rev) => ({ architecture: 'amd64', os: 'linux', config: { Labels: { 'org.opencontainers.image.revision': rev } } });

function verify(images, ref) {
  const h = history();
  const bin = fakeDocker(typeof images === 'function' ? images(h) : images);
  const summary = join(h.dir, 'summary.md');
  const output = join(h.dir, 'output.txt');
  const r = bash(VERIFY, { PATH: `${bin}:${process.env.PATH}`, REF: ref, GITHUB_SHA: h.head, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output }, h.dir);
  return { ...r, h, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '', output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
}

test('artifact verification accepts a revision-labelled image whose revision is the current main', () => {
  const r = verify((h) => ({ [digest('1b')]: labelled(h.head) }), `${IMAGE_NAME}@${digest('1b')}`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.summary, new RegExp(`index digest: \`${digest('1b')}\``));
  assert.match(r.summary, new RegExp(`revision: \`${r.h.head}\``));
  assert.equal(r.output, `revision=${r.h.head}\n`, 'the only output handed to the deploy job is the verified revision');
});

test('artifact verification accepts an EARLIER main artifact (rollback to a labelled main build, OD-4)', () => {
  const r = verify((h) => ({ [digest('2c')]: labelled(h.earlier) }), `${IMAGE_NAME}@${digest('2c')}`);
  assert.equal(r.code, 0, r.out);
});

test('artifact verification accepts the multi-platform shape (linux/amd64 entry)', () => {
  const r = verify((h) => ({ [digest('3d')]: { 'linux/amd64': labelled(h.head), 'linux/arm64': labelled(h.head) } }), `${IMAGE_NAME}@${digest('3d')}`);
  assert.equal(r.code, 0, r.out);
});

test('artifact verification refuses a digest that does not exist in the auth-service repository', () => {
  const r = verify({}, `${IMAGE_NAME}@${digest('4e')}`);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /does not exist in the auth-service repository/);
  assert.equal(r.summary, '');
});

test('artifact verification refuses an unlabelled (legacy) image, OD-3', () => {
  const r = verify({ [digest('5f')]: { architecture: 'amd64', os: 'linux', config: { Labels: null } } }, `${IMAGE_NAME}@${digest('5f')}`);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no org\.opencontainers\.image\.revision label/);
});

test('artifact verification refuses an image whose revision is not on main (a pull-request build such as :develop)', () => {
  const r = verify((h) => ({ [digest('6a')]: labelled(h.side) }), `${IMAGE_NAME}@${digest('6a')}`);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /is not an ancestor of main/);
});

test('artifact verification refuses a malformed or unknown revision label', () => {
  for (const rev of ['main', 'abc', `${'0'.repeat(40)}`, `$(id)`]) {
    const r = verify({ [digest('7b')]: labelled(rev) }, `${IMAGE_NAME}@${digest('7b')}`);
    assert.notEqual(r.code, 0, `accepted revision ${rev}`);
  }
});
